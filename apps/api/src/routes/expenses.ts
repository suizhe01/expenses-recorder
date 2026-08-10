import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { Database } from '../db.js';
import { BOM, centsCell, csvRow, plainCell, textCell, timestampCell } from '../csv.js';
import { authenticatedUserId, requireAuth } from '../auth/guard.js';
import {
  findLiveCategoryById,
  findLiveCategoryIds,
} from '../categories/categories.js';
import { findLiveById } from '../receipts/receipts.js';
import { fieldErrors } from '../validation.js';
import {
  findExpenseById,
  insertExpense,
  listExpenses,
  listExpensePage,
  softDeleteExpense,
  toExpense,
  updateExpense,
  type ExpenseCursor,
  type ExpenseInput,
  type ExpensePageRow,
} from '../expenses/expenses.js';

/**
 * AC-13. One body for an id that does not exist, one belonging to somebody
 * else, one that has been deleted, and one that is not a uuid at all.
 */
const NOT_FOUND = { error: 'Expense not found' } as const;

/**
 * AC-9. 422 rather than 404, because the 404 above belongs to the id in the
 * path. A client that gets 422 knows its own expense is fine and the reference
 * it sent is not — and the wording is identical whether the id is unknown,
 * another user's, or soft-deleted.
 */
const CATEGORY_NOT_FOUND = { error: 'Category not found' } as const;
const RECEIPT_NOT_FOUND = { error: 'Receipt not found' } as const;

/** AC-10 and AC-15. */
const RECEIPT_TAKEN = {
  error: 'Receipt is already attached to an expense',
} as const;

/** Malaysia is UTC+8 year round; there is no daylight saving to track. */
const MALAYSIA_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * AC-7. Today's calendar date in Malaysia.
 *
 * Shifting the instant and then reading the UTC date is what makes this correct
 * without a timezone library: at 23:30 in Kuala Lumpur the UTC date is still
 * yesterday, so comparing against UTC would refuse an expense entered tonight
 * for today. Exported so a test can pin "today" rather than depending on when
 * it runs.
 */
export function todayInMalaysia(now: number = Date.now()): string {
  return new Date(now + MALAYSIA_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * `2026-02-30` matches the shape of a date without being one. Building it in UTC
 * and checking the parts survive is what rejects it: Date would silently roll it
 * forward to March 2nd and store a day the user never chose.
 */
function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

const purchasedOnSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'must be a date as YYYY-MM-DD' })
  .refine(isCalendarDate, { message: 'must be a real calendar date' })
  .refine((value) => value <= todayInMalaysia(), {
    // Both sides are YYYY-MM-DD, where a string comparison is a date
    // comparison.
    message: 'must not be in the future',
  });

/** Seconds are optional on input and Postgres stores `14:31` as `14:31:00`. */
const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, {
    message: 'must be a 24-hour time as HH:MM or HH:MM:SS',
  });

/**
 * AC-8. Three letters, stored uppercase, so `myr` and `MYR` cannot both appear
 * in an archive and look like different currencies.
 */
const currencySchema = z
  .string()
  .regex(/^[A-Za-z]{3}$/, { message: 'must be a three-letter currency code' })
  .transform((value) => value.toUpperCase());

/**
 * AC-8. Trimmed, length-checked, and blank becomes null — an empty merchant name
 * is an absent one, and storing `''` would make a picker show a nameless row.
 * `.nullable()` wraps the whole pipeline, so an explicit null passes straight
 * through, which is how AC-14 clears a field.
 */
function textSchema(max: number) {
  return z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().max(max, { message: `must be at most ${max} characters` }))
    .transform((value) => (value === '' ? null : value))
    .nullable();
}

const uuidSchema = z.string().uuid({ message: 'must be a uuid' });

/** AC-6. Positive: a refund is not an expense (NG-11). */
const totalCentsSchema = z
  .number()
  .int({ message: 'must be a whole number of cents' })
  .positive({ message: 'must be greater than zero' });

/** AC-6. A component line may be zero but never negative. */
const componentCentsSchema = z
  .number()
  .int({ message: 'must be a whole number of cents' })
  .min(0, { message: 'must not be negative' })
  .nullable();

/** AC-6. Signed: receipts round to the nearest 5 sen in either direction. */
const roundingCentsSchema = z
  .number()
  .int({ message: 'must be a whole number of cents' })
  .nullable();

/**
 * AC-4 to AC-8. The three required fields, then everything a Malaysian tax
 * invoice prints.
 *
 * Note there is no `.strict()`: an unknown key is ignored rather than rejected,
 * matching every other route here.
 */
const createSchema = z.object({
  categoryId: uuidSchema,
  totalCents: totalCentsSchema,
  purchasedOn: purchasedOnSchema,
  receiptId: uuidSchema.nullable().optional(),
  purchasedAtTime: timeSchema.nullable().optional(),
  subtotalCents: componentCentsSchema.optional(),
  taxCents: componentCentsSchema.optional(),
  roundingCents: roundingCentsSchema.optional(),
  currency: currencySchema.optional(),
  merchantName: textSchema(255).optional(),
  merchantTaxId: textSchema(255).optional(),
  receiptNumber: textSchema(255).optional(),
  paymentMethod: textSchema(255).optional(),
  note: textSchema(1000).optional(),
});

/**
 * AC-14. Every field optional, but the three required ones stay non-nullable, so
 * `{"categoryId": null}` is a 400 rather than a way to orphan an expense.
 */
const patchSchema = createSchema.partial();

const paramsSchema = z.object({
  id: uuidSchema,
});

/**
 * EXP-18 AC-1 to AC-8. The filters `GET /expenses` accepts.
 *
 * Fastify parses a repeated key into an array and a single one into a string
 * (verified, not assumed), so `categoryId` accepts both and normalises to an
 * array — the store then treats one id and ten identically.
 *
 * `from` and `to` reuse `purchasedOnSchema` wholesale rather than restating its
 * rules: same format, same real-calendar-date check, same rejection of the
 * future via `todayInMalaysia` (AC-7). One implementation, so the filter and the
 * write can never disagree about what a valid date is.
 *
 * Nothing here is a Fastify `querystring` schema (NG-4) — this is a zod parse
 * inside the handler, so a bad parameter is answered by code that can choose its
 * own status rather than by Fastify's validator.
 */
const categoryIdFilterSchema = z
  .union([uuidSchema, z.array(uuidSchema)])
  .transform((value) => (Array.isArray(value) ? value : [value]));

const querySchema = z
  .object({
    from: purchasedOnSchema.optional(),
    to: purchasedOnSchema.optional(),
    categoryId: categoryIdFilterSchema.optional(),
    hasReceipt: z
      .enum(['true', 'false'], {
        // Reached by `hasReceipt=maybe` and by `hasReceipt=` alike.
        message: "must be 'true' or 'false'",
      })
      .transform((value) => value === 'true')
      .optional(),
  })
  // EXP-19 AC-6. Strict, so a misspelled or bracket-syntax filter is refused
  // rather than dropped. Ignoring `?catgeoryId=x` returned an unfiltered list
  // with a 200 — indistinguishable from a successful narrow query, which is the
  // failure EXP-18's 400-rather-than-ignore rule exists to prevent.
  //
  // Called on the object and BEFORE `superRefine`, which returns a ZodEffects
  // that has no `.strict`.
  //
  // Scoped to this route on purpose (NG-2): `/auth/verify` and
  // `/auth/reset-password` also parse query strings, and their URLs arrive by
  // email — strictness there would break a valid link the moment a mail client
  // appended a tracking parameter.
  .strict()
  // AC-8. Both parameters are named because either could be the typo, and a
  // client showing "from: ..." against one field only would hide half the fix.
  .superRefine((value, context) => {
    if (value.from !== undefined && value.to !== undefined && value.from > value.to) {
      for (const path of ['from', 'to'] as const) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [path],
          message: 'from must not be later than to',
        });
      }
    }
  });


/**
 * EXP-20 AC-4. The export's columns, in order.
 *
 * Human-readable rather than the API's field names: this file is opened by a
 * person or handed to an accountant, where `Purchase Date` beats `purchasedOn`.
 * The money columns drop the `Cents` suffix because AC-5 renders them as
 * decimals — a column headed `Total Cents` holding `149.30` would be a lie.
 */
const EXPORT_HEADER = [
  'ID',
  'Purchase Date',
  'Purchase Time',
  'Category',
  'Category ID',
  'Merchant',
  'Merchant Tax ID',
  'Receipt No',
  'Total',
  'Subtotal',
  'Tax',
  'Rounding',
  'Currency',
  'Payment Method',
  'Note',
  'Receipt ID',
  'Created At',
  'Updated At',
];

/**
 * EXP-20 AC-5, AC-6, AC-7, AC-10. One row, in `EXPORT_HEADER`'s order.
 *
 * Which cell helper each column gets is the security decision here, not a
 * detail: `textCell` carries the formula guard and is used for exactly the
 * columns whose contents a user typed. Ids, dates and amounts this codebase
 * generated go through `plainCell` and `centsCell`, so a negative rounding
 * stays a number a spreadsheet can sum.
 */
function exportCells(row: ExpensePageRow): string[] {
  return [
    plainCell(row.id),
    plainCell(row.purchased_on),
    plainCell(row.purchased_at_time),
    textCell(row.category_name),
    plainCell(row.category_id),
    textCell(row.merchant_name),
    textCell(row.merchant_tax_id),
    textCell(row.receipt_number),
    centsCell(row.total_cents),
    centsCell(row.subtotal_cents),
    centsCell(row.tax_cents),
    centsCell(row.rounding_cents),
    textCell(row.currency),
    textCell(row.payment_method),
    textCell(row.note),
    plainCell(row.receipt_id),
    timestampCell(row.created_at),
    timestampCell(row.updated_at),
  ];
}

/**
 * AC-13. Rows per round-trip. Large enough that a year of receipts is a couple
 * of queries, small enough that one batch is never a meaningful amount of
 * memory.
 */
const EXPORT_BATCH_SIZE = 500;

/**
 * EXP-11. Documentation only — no `body`, `querystring`, or `params` schema, for
 * the reasons recorded in `categories.ts`.
 *
 * Every field is named because Fastify's serialiser is an allowlist: anything
 * missing here is stripped from the response. `category` is spelled out as a
 * nested object for the same reason — a bare `{ type: 'object' }` would emit
 * `{}`.
 */
const expenseResponse = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    category: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
      },
    },
    // Null for a manual entry with no photograph.
    receiptId: { type: ['string', 'null'], format: 'uuid' },
    purchasedOn: { type: 'string', format: 'date' },
    purchasedAtTime: { type: ['string', 'null'] },
    totalCents: { type: 'integer' },
    subtotalCents: { type: ['integer', 'null'] },
    taxCents: { type: ['integer', 'null'] },
    roundingCents: { type: ['integer', 'null'] },
    currency: { type: 'string' },
    merchantName: { type: ['string', 'null'] },
    merchantTaxId: { type: ['string', 'null'] },
    receiptNumber: { type: ['string', 'null'] },
    paymentMethod: { type: ['string', 'null'] },
    note: { type: ['string', 'null'] },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

const expenseError = {
  type: 'object',
  properties: { error: { type: 'string' } },
} as const;

const expenseValidationError = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    fields: { type: 'object', additionalProperties: { type: 'string' } },
  },
} as const;

export type ExpenseRouteOptions = {
  database: Database;
};

export function registerExpenseRoutes(
  app: FastifyInstance,
  { database }: ExpenseRouteOptions,
): void {
  // AC-20: the same guard the category and receipt routes use, unchanged.
  app.addHook('preHandler', requireAuth);

  /**
   * AC-9. Checks only the references the request actually mentions.
   *
   * A null `receiptId` is a deliberate detach (AC-15) and has nothing to
   * validate, which is why the check is on the value rather than on the key
   * being present.
   */
  async function badReference(
    userId: string,
    fields: ExpenseInput,
  ): Promise<typeof CATEGORY_NOT_FOUND | typeof RECEIPT_NOT_FOUND | undefined> {
    if (typeof fields.categoryId === 'string') {
      const category = await findLiveCategoryById(
        database.pool,
        userId,
        fields.categoryId,
      );

      if (!category) {
        return CATEGORY_NOT_FOUND;
      }
    }

    if (typeof fields.receiptId === 'string') {
      const receipt = await findLiveById(database.pool, userId, fields.receiptId);

      if (!receipt) {
        return RECEIPT_NOT_FOUND;
      }
    }

    return undefined;
  }

  /**
   * EXP-18 AC-9, shared with the export by EXP-20 AC-2.
   *
   * Checked before the query runs, so filtering by something that cannot match
   * is reported rather than answered with a plausible empty result. For the
   * export that matters more than for the list: an empty CSV looks like a
   * successful export of a period with no spending.
   */
  async function unknownCategoryFilter(
    userId: string,
    categoryIds: string[] | undefined,
  ): Promise<boolean> {
    if (categoryIds === undefined) {
      return false;
    }

    const live = await findLiveCategoryIds(database.pool, userId, categoryIds);

    return categoryIds.some((id) => !live.has(id));
  }

  app.get('/expenses', {
    schema: {
      tags: ['Expenses'],
      summary: 'List live expenses, newest purchase first',
      // EXP-18 AC-13. The parameters are described here in prose rather than as a
      // `querystring` schema, which is banned repo-wide: it would switch on
      // Fastify request validation and answer 400 before any handler runs.
      description:
        'Ordered by purchase date descending, ties broken by when the expense was '
        + 'recorded. Still unpaginated.\n\n'
        + 'Four optional query parameters, combined with AND:\n\n'
        + '- `from` and `to` — `YYYY-MM-DD`, filtering `purchasedOn`. **Both bounds are '
        + 'inclusive**, so an expense dated exactly `from` or exactly `to` is returned. '
        + 'Either may be given alone; omit `to` for an open-ended upper bound, which is '
        + 'the only way to express "everything from here onwards" because a date in the '
        + 'future is rejected.\n'
        + '- `categoryId` — repeat the key to filter by several categories '
        + '(`?categoryId=a&categoryId=b`). An unknown, soft-deleted, or other '
        + "account's id answers 422.\n"
        + '- `hasReceipt` — `true` for expenses with a receipt attached, `false` for '
        + 'those without. Omit for no filter; no other value is accepted.\n\n'
        + 'A malformed parameter answers 400 naming it. Filters are never silently '
        + 'ignored, because a dropped `from` would return everything while looking like '
        + 'a successful narrow query.',
      security: [{ bearerAuth: [] }],
      response: {
        200: { type: 'array', items: expenseResponse },
        400: expenseValidationError,
        401: expenseError,
        422: expenseError,
      },
    },
  }, async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);

    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'Validation failed', fields: fieldErrors(parsed.error) });
    }

    const userId = authenticatedUserId(request);
    const { from, to, categoryId: categoryIds, hasReceipt } = parsed.data;

    if (await unknownCategoryFilter(userId, categoryIds)) {
      return reply.code(422).send(CATEGORY_NOT_FOUND);
    }

    const rows = await listExpenses(database.pool, userId, {
      from,
      to,
      categoryIds,
      hasReceipt,
    });

    return reply.code(200).send(rows.map(toExpense));
  });

  /**
   * EXP-20. The CSV export.
   *
   * Registered before `/expenses/:id` for readability only — Fastify's router
   * prefers a static segment over a parameter regardless of registration order,
   * which is what stops `export.csv` being read as an expense id (AC-16). A
   * test pins that rather than trusting it.
   */
  app.get('/expenses/export.csv', {
    schema: {
      tags: ['Expenses'],
      summary: 'Export the filtered expenses as a CSV download',
      // AC-15. Every parameter is prose here for the repo-wide reason: a
      // `querystring` schema would switch on Fastify request validation and
      // answer 400 before this handler runs.
      description:
        'Streams `text/csv; charset=utf-8` as an attachment. The response is not '
        + 'JSON and has no response schema — a Fastify response schema is an '
        + 'allowlist and would strip a streamed body.\n\n'
        + 'Takes the same four optional filters as `GET /expenses`, with identical '
        + 'semantics: `from`, `to` (both inclusive), repeatable `categoryId`, and '
        + '`hasReceipt`. A malformed or unrecognised parameter answers 400 naming '
        + 'it; an unknown, soft-deleted, or other account\'s `categoryId` answers '
        + '422.\n\n'
        + 'Rows run **oldest purchase first**, the reverse of `GET /expenses`, '
        + 'because a ledger reads forward in time. Columns: ID, Purchase Date, '
        + 'Purchase Time, Category, Category ID, Merchant, Merchant Tax ID, '
        + 'Receipt No, Total, Subtotal, Tax, Rounding, Currency, Payment Method, '
        + 'Note, Receipt ID, Created At, Updated At.\n\n'
        + 'Amounts are decimal strings with two places rather than integer cents, '
        + 'so a spreadsheet sums them as money. Timestamps are Malaysian time '
        + '(UTC+8). The body opens with a UTF-8 BOM so Excel decodes non-Latin '
        + 'merchant names. No matching expenses still returns 200, with the header '
        + 'row alone.\n\n'
        + 'The download is named from the range covered — '
        + '`expenses-<from>-to-<to>.csv`, where an omitted `from` becomes `start` '
        + 'and an omitted `to` becomes today.',
      security: [{ bearerAuth: [] }],
      response: {
        // AC-15. Deliberately no 200: this route streams, and naming a 200 schema
        // here would hand the body to Fastify's serialiser.
        400: expenseValidationError,
        401: expenseError,
        422: expenseError,
      },
    },
  }, async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);

    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'Validation failed', fields: fieldErrors(parsed.error) });
    }

    const userId = authenticatedUserId(request);
    const { from, to, categoryId: categoryIds, hasReceipt } = parsed.data;

    // AC-2. Both 400 and 422 are settled before a single byte is written —
    // once the stream starts there is no status code left to change.
    if (await unknownCategoryFilter(userId, categoryIds)) {
      return reply.code(422).send(CATEGORY_NOT_FOUND);
    }

    const filters = { from, to, categoryIds, hasReceipt };

    /**
     * AC-13. One batch in memory at a time, resumed by keyset rather than
     * OFFSET. Yielding a whole batch as one string keeps the write count down
     * without holding the export.
     */
    async function* records(): AsyncGenerator<string> {
      yield BOM + csvRow(EXPORT_HEADER);

      let cursor: ExpenseCursor | undefined;

      for (;;) {
        const batch = await listExpensePage(
          database.pool,
          userId,
          filters,
          cursor,
          EXPORT_BATCH_SIZE,
        );

        if (batch.length === 0) {
          return;
        }

        yield batch.map((row) => csvRow(exportCells(row))).join('');

        // A short batch means the last page; one more query would only prove it.
        if (batch.length < EXPORT_BATCH_SIZE) {
          return;
        }

        const last = batch[batch.length - 1] as ExpensePageRow;

        cursor = {
          purchasedOn: last.purchased_on,
          createdAt: last.created_at_text,
          id: last.id,
        };
      }
    }

    // AC-11. Named from the range actually covered, so two exports do not
    // collide in a downloads folder and each file says what is in it.
    const filename = `expenses-${from ?? 'start'}-to-${to ?? todayInMalaysia()}.csv`;

    // Taking the socket off Fastify: it must not serialise, append, or
    // error-handle a body being written a batch at a time. No Content-Length,
    // because the length is unknown until the last row — the response is
    // chunked.
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
    });

    try {
      // `pipeline` applies backpressure, so a slow client throttles the queries
      // rather than filling memory with batches it has not read.
      await pipeline(Readable.from(records(), { objectMode: false }), reply.raw);
    } catch (error) {
      // AC-14. The status line said 200 several batches ago, so there is no way
      // left to report this in-band. Destroying the socket gives the client a
      // truncated download it cannot mistake for a complete one — a CSV that
      // ends cleanly but short is the failure worth preventing, because it looks
      // exactly like a successful narrow export. The real error goes to the log
      // only, consistent with the global 5xx handler.
      request.log.error({ err: error }, 'expense CSV export failed mid-stream');
      reply.raw.destroy();
    }
  });

  app.post('/expenses', {
    schema: {
      tags: ['Expenses'],
      summary: 'Record an expense',
      description:
        'Requires categoryId, totalCents and purchasedOn; every other field is '
        + 'optional. Amounts are integer cents and the total must be positive. '
        + 'purchasedOn may not be in the future, judged in Malaysian time. currency '
        + 'defaults to MYR. Attaching a receipt that already backs a live expense '
        + 'answers 409; an unknown, soft-deleted, or other account\'s categoryId or '
        + 'receiptId answers 422.',
      security: [{ bearerAuth: [] }],
      response: {
        201: expenseResponse,
        400: expenseValidationError,
        401: expenseError,
        409: expenseError,
        422: expenseError,
      },
    },
  }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'Validation failed', fields: fieldErrors(parsed.error) });
    }

    const userId = authenticatedUserId(request);
    const bad = await badReference(userId, parsed.data);

    if (bad) {
      return reply.code(422).send(bad);
    }

    const outcome = await insertExpense(database.pool, userId, parsed.data);

    // AC-10: the index decided this, not a prior SELECT, so two confirmations
    // racing cannot both win.
    if (outcome.status === 'receipt-taken') {
      return reply.code(409).send(RECEIPT_TAKEN);
    }

    return reply.code(201).send(toExpense(outcome.expense));
  });

  app.get('/expenses/:id', {
    schema: {
      tags: ['Expenses'],
      summary: 'Fetch one expense',
      description:
        "An unknown id, another account's, a deleted one, and a malformed one all "
        + 'answer the same 404.',
      security: [{ bearerAuth: [] }],
      response: {
        200: expenseResponse,
        401: expenseError,
        404: expenseError,
      },
    },
  }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);

    // A malformed uuid cannot name a real expense, so it gets the 404 an
    // unknown id gets rather than a distinct validation error.
    if (!params.success) {
      return reply.code(404).send(NOT_FOUND);
    }

    const row = await findExpenseById(
      database.pool,
      authenticatedUserId(request),
      params.data.id,
    );

    if (!row) {
      return reply.code(404).send(NOT_FOUND);
    }

    return reply.code(200).send(toExpense(row));
  });

  app.patch('/expenses/:id', {
    schema: {
      tags: ['Expenses'],
      summary: 'Edit an expense',
      description:
        'Applies only the fields present in the body. An explicit null clears an '
        + 'optional field; categoryId, totalCents and purchasedOn cannot be nulled. '
        + 'receiptId may be set, swapped, or detached with null, still subject to one '
        + 'live expense per receipt.',
      security: [{ bearerAuth: [] }],
      response: {
        200: expenseResponse,
        400: expenseValidationError,
        401: expenseError,
        404: expenseError,
        409: expenseError,
        422: expenseError,
      },
    },
  }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(404).send(NOT_FOUND);
    }

    const parsed = patchSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'Validation failed', fields: fieldErrors(parsed.error) });
    }

    const userId = authenticatedUserId(request);
    const bad = await badReference(userId, parsed.data);

    if (bad) {
      return reply.code(422).send(bad);
    }

    // A body that names nothing is answered from a read, so an empty patch does
    // not bump `updated_at` — and a deleted or unknown id still answers 404
    // because this read excludes both.
    if (Object.keys(parsed.data).length === 0) {
      const row = await findExpenseById(database.pool, userId, params.data.id);

      if (!row) {
        return reply.code(404).send(NOT_FOUND);
      }

      return reply.code(200).send(toExpense(row));
    }

    const outcome = await updateExpense(
      database.pool,
      userId,
      params.data.id,
      parsed.data,
    );

    if (outcome.status === 'receipt-taken') {
      return reply.code(409).send(RECEIPT_TAKEN);
    }

    if (outcome.status === 'not-found') {
      return reply.code(404).send(NOT_FOUND);
    }

    return reply.code(200).send(toExpense(outcome.expense));
  });

  app.delete('/expenses/:id', {
    schema: {
      tags: ['Expenses'],
      summary: 'Soft delete an expense',
      description:
        'The row is kept and only marked deleted, and the receipt it held becomes '
        + 'available to confirm again. Deleting twice answers 404.',
      security: [{ bearerAuth: [] }],
      response: {
        // A 204 carries no body; `null` is how that is spelled in a schema.
        204: { type: 'null' },
        401: expenseError,
        404: expenseError,
      },
    },
  }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(404).send(NOT_FOUND);
    }

    const outcome = await softDeleteExpense(
      database.pool,
      authenticatedUserId(request),
      params.data.id,
    );

    // AC-16: an already-deleted expense answers exactly as an unknown one does.
    if (outcome.status === 'not-found') {
      return reply.code(404).send(NOT_FOUND);
    }

    return reply.code(204).send();
  });
}
