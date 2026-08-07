import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
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

export type ReceiptRouteOptions = {
  config: Config;
  database: Database;
};

export function registerReceiptRoutes(
  app: FastifyInstance,
  { config, database }: ReceiptRouteOptions,
): void {
  // AC-12: the same guard the category routes use, unchanged (NG-9).
  app.addHook('preHandler', requireAuth);

  app.get('/receipts', async (request, reply) => {
    const rows = await listReceipts(database.pool, authenticatedUserId(request));

    return reply.code(200).send(rows.map(toReceipt));
  });

  // AC-13: the limit applies to uploads alone. Listing, fetching and deleting
  // stay unlimited like the category routes — a phone browsing its own archive
  // must not be throttled. 60 an hour is far above filing receipts by hand and
  // far below what a runaway client or a stolen token could write to a home
  // disk unchecked.
  app.post('/receipts', { config: { rateLimit: UPLOAD_RATE_LIMIT } }, async (request, reply) => {
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
      return reply.code(200).send(toReceipt(existing));
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
        return reply.code(200).send(toReceipt(winner));
      }

      return reply.code(409).send({ error: 'Receipt could not be stored' });
    }

    return reply.code(201).send(toReceipt(outcome.receipt));
  });

  app.get('/receipts/:id/file', async (request, reply) => {
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

  app.delete('/receipts/:id', async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(404).send(NOT_FOUND);
    }

    // AC-10: the row is marked deleted; the file stays exactly where it is.
    const outcome = await softDeleteReceipt(
      database.pool,
      authenticatedUserId(request),
      params.data.id,
    );

    if (outcome.status === 'not-found') {
      return reply.code(404).send(NOT_FOUND);
    }

    return reply.code(204).send();
  });
}
