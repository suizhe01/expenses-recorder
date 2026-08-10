import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db.js';
import { authenticatedUserId, requireAuth } from '../auth/guard.js';
import { findLiveCategoryById } from '../categories/categories.js';
import { findLiveById } from '../receipts/receipts.js';
import {
  findExpenseById,
  insertExpense,
  listExpenses,
  softDeleteExpense,
  toExpense,
  updateExpense,
  type ExpenseInput,
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

function fieldErrors(error: z.ZodError): Record<string, string> {
  return Object.fromEntries(
    error.issues.map((issue) => [issue.path.join('.'), issue.message]),
  );
}

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

  app.get('/expenses', {
    schema: {
      tags: ['Expenses'],
      summary: 'List live expenses, newest purchase first',
      description:
        'Ordered by purchase date descending, ties broken by when the expense was '
        + 'recorded. Deliberately unfiltered and unpaginated; that arrives with export.',
      security: [{ bearerAuth: [] }],
      response: {
        200: { type: 'array', items: expenseResponse },
        401: expenseError,
      },
    },
  }, async (request, reply) => {
    const rows = await listExpenses(database.pool, authenticatedUserId(request));

    return reply.code(200).send(rows.map(toExpense));
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
