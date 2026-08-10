import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Database } from '../db.js';
import { authenticatedUserId, requireAuth } from '../auth/guard.js';
import {
  findLiveByHash,
  findLiveById,
  insertReceipt,
  listReceipts,
  softDeleteReceipt,
  toReceipt,
} from '../receipts/receipts.js';
import {
  commitFile,
  discardFile,
  fileIsPresent,
  filePath,
  storeUpload,
} from '../receipts/storage.js';
import type { ReceiptExtractor } from '../receipts/extraction.js';
import {
  latestExtractionsFor,
  recordExtraction,
  toExtraction,
  type ExtractionRow,
} from '../receipts/extraction-store.js';
import { liveExpenseIdFor, liveExpenseIdsFor } from '../expenses/expenses.js';

const paramsSchema = z.object({
  id: z.string().uuid(),
});

/**
 * AC-11. One body for an id that does not exist and for one belonging to
 * somebody else, so the API never confirms another user's receipt is real.
 */
const NOT_FOUND = { error: 'Receipt not found' } as const;

const NO_FILE = { error: 'Expected one file part' } as const;
const TOO_LARGE = { error: 'File is larger than the upload limit' } as const;
const UNSUPPORTED = {
  error: 'File must be a JPEG, PNG, WebP, or HEIC image',
} as const;

/**
 * EXP-14 AC-1. The receipt exists; its bytes cannot be served right now. Says
 * nothing about where the file should have been.
 */
const FILE_UNAVAILABLE = {
  error: 'Receipt image is temporarily unavailable',
} as const;

/** EXP-16 AC-18. The receipt is this user's, and an expense still needs it. */
const RECEIPT_ATTACHED = {
  error: 'Receipt is attached to an expense',
} as const;

/** AC-13. Applied to `POST /receipts` only, via that route's own config. */
export const UPLOAD_RATE_LIMIT = { max: 60, timeWindow: '1 hour' } as const;

/** Filenames arrive from a client. Kept as provenance, never used as a path. */
const MAX_FILENAME_LENGTH = 255;

function safeFilename(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();

  return trimmed === '' ? null : trimmed.slice(0, MAX_FILENAME_LENGTH);
}

/**
 * EXP-15 AC-9. The reading attached to a receipt.
 *
 * Every field is listed because Fastify's serialiser is an allowlist: anything
 * absent here is stripped from the response. That cut both ways during this
 * build — the extraction vanished silently until it was declared — and it is
 * also the guarantee that `prompt_tokens`, `output_tokens` and `cost_micros`
 * can never leak, since a schema that does not name them cannot emit them.
 */
const extractionResponse = {
  type: ['object', 'null'],
  properties: {
    status: { type: 'string' },
    isReceipt: { type: ['boolean', 'null'] },
    confidence: { type: ['number', 'null'] },
    merchantName: { type: ['string', 'null'] },
    merchantTaxId: { type: ['string', 'null'] },
    receiptNumber: { type: ['string', 'null'] },
    purchasedOn: { type: ['string', 'null'] },
    purchasedAtTime: { type: ['string', 'null'] },
    subtotalCents: { type: ['integer', 'null'] },
    taxCents: { type: ['integer', 'null'] },
    roundingCents: { type: ['integer', 'null'] },
    totalCents: { type: ['integer', 'null'] },
    currency: { type: ['string', 'null'] },
    paymentMethod: { type: ['string', 'null'] },
    extractedAt: { type: 'string' },
  },
} as const;

/**
 * EXP-11. Documentation only — no `body`, `querystring`, or `params` schema,
 * for the reasons recorded in `categories.ts`. The upload body is multipart and
 * is described in prose rather than by a schema, and the file endpoint declares
 * no response schema at all because it streams bytes, not JSON.
 */
const receiptResponse = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    contentType: { type: 'string' },
    byteSize: { type: 'number' },
    // Nullable when the client sent no filename; a bare 'string' would strip it.
    originalFilename: { type: ['string', 'null'] },
    createdAt: { type: 'string', format: 'date-time' },
    extraction: extractionResponse,
    // EXP-16 AC-19. The live expense this receipt was confirmed into, or null
    // when it is still waiting to be filed — which is what lets a client show an
    // inbox of unconfirmed receipts. Declared here because the serialiser is an
    // allowlist and would otherwise strip it silently, exactly as it did to
    // `extraction` during EXP-15.
    expenseId: { type: ['string', 'null'], format: 'uuid' },
  },
} as const;

const receiptError = {
  type: 'object',
  properties: { error: { type: 'string' } },
} as const;

export type ReceiptRouteOptions = {
  config: Config;
  database: Database;
  extractor: ReceiptExtractor;
};

export function registerReceiptRoutes(
  app: FastifyInstance,
  { config, database, extractor }: ReceiptRouteOptions,
): void {
  /**
   * EXP-15 AC-4 to AC-6. Reads the stored bytes, records the attempt, and
   * returns the row to expose.
   *
   * Never throws. Every failure path inside the extractor already resolves to
   * `failed`, and the write itself is wrapped, because AC-6 is absolute: an
   * upload must not be lost because a third party had a bad day. If even
   * recording the attempt fails, the receipt still stands and the request still
   * succeeds.
   */
  async function runExtraction(
    request: FastifyRequest,
    receiptId: string,
    userId: string,
    sha256: string,
    contentType: string,
  ): Promise<ExtractionRow | undefined> {
    try {
      const bytes = await readFile(filePath(config.RECEIPTS_PATH, userId, sha256));
      const result = await extractor.extract({ bytes, contentType });

      if (result.status === 'failed') {
        request.log.warn(
          { receiptId, model: extractor.model, reason: result.error },
          'receipt extraction failed',
        );
      }

      return await recordExtraction(database.pool, receiptId, extractor.model, result);
    } catch (error) {
      request.log.error({ err: error, receiptId }, 'could not record extraction');
      return undefined;
    }
  }
  // AC-12: the same guard the category routes use, unchanged (NG-9).
  app.addHook('preHandler', requireAuth);

  app.get('/receipts', {
    schema: {
      tags: ['Receipts'],
      summary: 'List live receipts, newest first',
      security: [{ bearerAuth: [] }],
      response: {
        200: { type: 'array', items: receiptResponse },
        401: receiptError,
      },
    },
  }, async (request, reply) => {
    const rows = await listReceipts(database.pool, authenticatedUserId(request));
    const extractions = await latestExtractionsFor(
      database.pool,
      rows.map((row) => row.id),
    );
    // EXP-16 AC-19. One query for the whole page rather than one per receipt.
    const expenseIds = await liveExpenseIdsFor(
      database.pool,
      rows.map((row) => row.id),
    );

    return reply.code(200).send(
      rows.map((row) => {
        const extraction = extractions.get(row.id);

        return {
          ...toReceipt(row),
          extraction: extraction ? toExtraction(extraction) : null,
          expenseId: expenseIds.get(row.id) ?? null,
        };
      }),
    );
  });

  // AC-13: the limit applies to uploads alone. Listing, fetching and deleting
  // stay unlimited like the category routes — a phone browsing its own archive
  // must not be throttled. 60 an hour is far above filing receipts by hand and
  // far below what a runaway client or a stolen token could write to a home
  // disk unchecked.
  app.post('/receipts', {
    config: { rateLimit: UPLOAD_RATE_LIMIT },
    schema: {
      tags: ['Receipts'],
      summary: 'Upload a receipt image',
      description:
        'multipart/form-data with a single file part. The type is determined by reading '
        + "the file's own signature bytes, not the declared Content-Type: JPEG, PNG, WebP "
        + 'or HEIC only. Uploading bytes already held answers 200 with the existing '
        + 'receipt rather than creating a duplicate. Limited to 60 uploads an hour per '
        + 'account.',
      consumes: ['multipart/form-data'],
      security: [{ bearerAuth: [] }],
      response: {
        200: receiptResponse,
        201: receiptResponse,
        400: receiptError,
        401: receiptError,
        409: receiptError,
        413: receiptError,
        415: receiptError,
      },
    },
  }, async (request, reply) => {
    const userId = authenticatedUserId(request);

    const part = await request.file();

    if (!part) {
      return reply.code(400).send(NO_FILE);
    }

    // AC-3 to AC-5. The stream is hashed, measured and sniffed on its way to a
    // temporary file; nothing is placed under its final name until it has been
    // accepted.
    const result = await storeUpload(config.RECEIPTS_PATH, userId, part.file);

    if (result.status === 'unsupported-type' || result.status === 'empty') {
      return reply.code(415).send(UNSUPPORTED);
    }

    const { file } = result;

    // AC-4. The multipart plugin enforces its own `fileSize` limit by
    // TRUNCATING the stream rather than erroring, so an oversized upload
    // arrives here looking like a complete, under-limit file — and would be
    // stored as a corrupt receipt that reports success. The flag is the only
    // way to tell the two apart, and it must be checked before anything is
    // committed.
    if (part.file.truncated) {
      await discardFile(file);
      return reply.code(413).send(TOO_LARGE);
    }

    // AC-6: an upload the user already holds is idempotent. The temporary file
    // is discarded rather than committed, so a retry cannot double disk usage.
    const existing = await findLiveByHash(database.pool, userId, file.sha256);

    if (existing) {
      await discardFile(file);

      // AC-8: dedup is unchanged — no second file, no second receipt row — but
      // a duplicate upload IS the retry path, so it runs a fresh extraction and
      // adds an attempt. Without this, "re-upload to try again" would silently
      // do nothing.
      const extraction = await runExtraction(
        request,
        existing.id,
        userId,
        existing.sha256,
        existing.content_type,
      );

      return reply.code(200).send({
        ...toReceipt(existing),
        extraction: extraction ? toExtraction(extraction) : null,
        // EXP-16 AC-19. A re-upload of bytes already confirmed reports the
        // expense holding them, so a client can tell "already filed" from
        // "still in the inbox" without a second call.
        expenseId: await liveExpenseIdFor(database.pool, existing.id),
      });
    }

    // AC-5 and AC-7: committed before the row is inserted, so a receipt can
    // never reference bytes that are not on disk. If the target name already
    // exists it holds identical content — the name is the hash — which is what
    // lets a previously deleted image be re-uploaded without a second copy.
    await commitFile(config.RECEIPTS_PATH, userId, file);

    const outcome = await insertReceipt(database.pool, userId, {
      sha256: file.sha256,
      byteSize: file.byteSize,
      contentType: file.contentType,
      originalFilename: safeFilename(part.filename),
    });

    // Two identical uploads racing: the index let exactly one through, and the
    // loser answers with the winner rather than failing.
    if (outcome.status === 'duplicate') {
      const winner = await findLiveByHash(database.pool, userId, file.sha256);

      if (winner) {
        return reply.code(200).send({
          ...toReceipt(winner),
          expenseId: await liveExpenseIdFor(database.pool, winner.id),
        });
      }

      return reply.code(409).send({ error: 'Receipt could not be stored' });
    }

    // AC-4: inside the request, so the response carries the reading. AC-6: a
    // failure here still returns 201 with the receipt intact.
    const extraction = await runExtraction(
      request,
      outcome.receipt.id,
      userId,
      file.sha256,
      file.contentType,
    );

    return reply.code(201).send({
      ...toReceipt(outcome.receipt),
      extraction: extraction ? toExtraction(extraction) : null,
      // EXP-16 AC-19. Always null: the receipt was created a moment ago and
      // nothing can have confirmed it yet. Stated rather than omitted so the
      // field is present on every receipt payload.
      expenseId: null,
    });
  });

  app.get('/receipts/:id/file', {
    schema: {
      tags: ['Receipts'],
      summary: 'Download the image bytes',
      description:
        'Streams the file with its stored content type and `Cache-Control: private, '
        + 'no-store`. Answers 404 for an unknown receipt or one belonging to another '
        + 'account, and 503 when the row is live but its bytes are missing from storage. '
        + 'No response schema is declared here: the body is binary, and a schema would '
        + 'serialise it as JSON.',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(404).send(NOT_FOUND);
    }

    const userId = authenticatedUserId(request);
    const row = await findLiveById(database.pool, userId, params.data.id);

    // AC-11: the path is built from the row's own user_id, which was matched
    // against the caller. There is no way to reach another user's directory.
    if (!row) {
      return reply.code(404).send(NOT_FOUND);
    }

    // EXP-14 AC-1: check before streaming. Handing `createReadStream` a path
    // that does not exist produced a 500 whose body carried the absolute path,
    // the owner's id and the content hash.
    //
    // There is still a window between this check and the read — the file could
    // vanish in between — but that lands on the global error handler, which
    // now returns a generic body. This turns the case that actually happens,
    // a database restored without its volume, into an honest answer.
    if (!(await fileIsPresent(config.RECEIPTS_PATH, userId, row.sha256))) {
      // The path goes in the log and nowhere near the response: an operator
      // needs somewhere to look, and this is the one place it is safe to say.
      request.log.error(
        {
          receiptId: row.id,
          sha256: row.sha256,
          userId,
          path: filePath(config.RECEIPTS_PATH, userId, row.sha256),
        },
        'receipt row is live but its file is missing from storage',
      );

      // Deliberately no Retry-After: a refresh lock clears in a second, but a
      // missing volume needs a human. Advising a retry the client would obey
      // is worse than none.
      return reply.code(503).send(FILE_UNAVAILABLE);
    }

    // AC-9: a receipt is private and may be produced as evidence years later.
    // No intermediary should hold a copy.
    return reply
      .code(200)
      .type(row.content_type)
      .header('content-length', String(row.byte_size))
      .header('cache-control', 'private, no-store')
      .send(createReadStream(filePath(config.RECEIPTS_PATH, userId, row.sha256)));
  });

  app.delete('/receipts/:id', {
    schema: {
      tags: ['Receipts'],
      summary: 'Soft delete a receipt',
      description:
        'The row is marked deleted and the file is never removed from disk. Deleting '
        + 'twice answers 404. A receipt attached to a live expense answers 409 and is '
        + 'not deleted; detach or delete that expense first.',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(404).send(NOT_FOUND);
    }

    const userId = authenticatedUserId(request);

    // EXP-16 AC-18. Ownership is settled FIRST, so a receipt belonging to
    // somebody else answers 404 whether or not they have confirmed it. Checking
    // attachment first would answer 409 for another account's receipt and turn
    // this route into an oracle for which ids are real.
    const own = await findLiveById(database.pool, userId, params.data.id);

    if (!own) {
      return reply.code(404).send(NOT_FOUND);
    }

    // Refusing rather than cascading: an expense is a tax record and this
    // receipt is the document that proves it. Letting the image disappear from
    // under it would defeat the point of keeping receipts at all. Detaching or
    // deleting the expense first is the way through.
    if (await liveExpenseIdFor(database.pool, params.data.id)) {
      return reply.code(409).send(RECEIPT_ATTACHED);
    }

    // AC-10: the row is marked deleted; the file stays exactly where it is.
    const outcome = await softDeleteReceipt(
      database.pool,
      userId,
      params.data.id,
    );

    if (outcome.status === 'not-found') {
      return reply.code(404).send(NOT_FOUND);
    }

    return reply.code(204).send();
  });
}
