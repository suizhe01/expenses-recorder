import type { Executor } from '../auth/sessions.js';

/** Postgres unique-violation, raised by the partial index on live receipt ids. */
const UNIQUE_VIOLATION = '23505';

export type ExpenseRow = {
  id: string;
  user_id: string;
  category_id: string;
  category_name: string;
  receipt_id: string | null;
  /** Read as text, never as a Date. See PROJECTION. */
  purchased_on: string;
  purchased_at_time: string | null;
  total_cents: number;
  subtotal_cents: number | null;
  tax_cents: number | null;
  rounding_cents: number | null;
  currency: string;
  merchant_name: string | null;
  merchant_tax_id: string | null;
  receipt_number: string | null;
  payment_method: string | null;
  note: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

/** AC-11. Ids plus the category's name, so a list renders without a second call. */
export type Expense = {
  id: string;
  category: { id: string; name: string };
  receiptId: string | null;
  purchasedOn: string;
  purchasedAtTime: string | null;
  totalCents: number;
  subtotalCents: number | null;
  taxCents: number | null;
  roundingCents: number | null;
  currency: string;
  merchantName: string | null;
  merchantTaxId: string | null;
  receiptNumber: string | null;
  paymentMethod: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
};

export function toExpense(row: ExpenseRow): Expense {
  return {
    id: row.id,
    category: { id: row.category_id, name: row.category_name },
    receiptId: row.receipt_id,
    purchasedOn: row.purchased_on,
    purchasedAtTime: row.purchased_at_time,
    totalCents: row.total_cents,
    subtotalCents: row.subtotal_cents,
    taxCents: row.tax_cents,
    roundingCents: row.rounding_cents,
    currency: row.currency,
    merchantName: row.merchant_name,
    merchantTaxId: row.merchant_tax_id,
    receiptNumber: row.receipt_number,
    paymentMethod: row.payment_method,
    note: row.note,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Every read of an expense, including the rows returned by writes.
 *
 * `purchased_on` is converted to text **in SQL** rather than through the Date
 * that `pg` would otherwise hand back. `pg` parses a `date` into a Date at
 * *local* midnight, so on a UTC+8 machine `2026-08-08` becomes
 * `2026-08-07T16:00:00Z` and the obvious `toISOString().slice(0, 10)` reports
 * the day before. Measured, not theorised. `to_char` has no timezone in it at
 * all and gives the same answer wherever this runs.
 *
 * The join to `categories` deliberately does **not** filter on the category's
 * `deleted_at` (AC-12): categories are only ever soft-deleted, so the row is
 * always there, and an expense filed against a category deleted since must
 * still read "Medical" rather than lose its label.
 */
const PROJECTION = `e.id, e.user_id, e.category_id, c.name AS category_name,
  e.receipt_id, to_char(e.purchased_on, 'YYYY-MM-DD') AS purchased_on,
  e.purchased_at_time, e.total_cents, e.subtotal_cents, e.tax_cents,
  e.rounding_cents, e.currency, e.merchant_name, e.merchant_tax_id,
  e.receipt_number, e.payment_method, e.note, e.created_at, e.updated_at,
  e.deleted_at`;

const FROM_EXPENSES = `FROM expenses e JOIN categories c ON c.id = e.category_id`;

/**
 * The one place a request field is mapped to a column name. Both the insert and
 * the patch build their SQL from this, so the two can never drift, and a column
 * name can only ever come from this table rather than from request input.
 */
const COLUMN_FOR = {
  categoryId: 'category_id',
  receiptId: 'receipt_id',
  purchasedOn: 'purchased_on',
  purchasedAtTime: 'purchased_at_time',
  totalCents: 'total_cents',
  subtotalCents: 'subtotal_cents',
  taxCents: 'tax_cents',
  roundingCents: 'rounding_cents',
  currency: 'currency',
  merchantName: 'merchant_name',
  merchantTaxId: 'merchant_tax_id',
  receiptNumber: 'receipt_number',
  paymentMethod: 'payment_method',
  note: 'note',
} as const;

export type ExpenseField = keyof typeof COLUMN_FOR;

/** A partial set of fields to write. Absent keys are left alone (AC-14). */
export type ExpenseInput = Partial<Record<ExpenseField, string | number | null>>;

/** AC-4. The three the route guarantees; the rest are optional. */
export type CreateExpenseValues = ExpenseInput & {
  categoryId: string;
  totalCents: number;
  purchasedOn: string;
};

type Entry = [ExpenseField, string | number | null];

/**
 * `undefined` means "not mentioned" and must never reach SQL as a value — pg
 * would send it as NULL and a patch of one field would erase the others.
 */
function entriesOf(input: ExpenseInput): Entry[] {
  return Object.entries(input).filter(([, value]) => value !== undefined) as Entry[];
}

/**
 * EXP-18. Every filter is optional and they combine with AND (AC-5).
 *
 * `from`/`to` are `YYYY-MM-DD` strings, compared as dates in SQL — never parsed
 * into a JavaScript Date (AC-10). That is the EXP-17 lesson: a `date` becomes a
 * Date at *local* midnight, so anything that routes a date-only value through JS
 * shifts it by a day east of UTC.
 */
export type ExpenseFilters = {
  from?: string;
  to?: string;
  categoryIds?: string[];
  hasReceipt?: boolean;
};

/**
 * The WHERE clause every filtered read shares.
 *
 * Extracted in EXP-20 so the list and the CSV export cannot drift: an export
 * that filtered even slightly differently from the list would hand someone a
 * file that disagrees with the screen it was exported from, and nothing would
 * say which was right.
 *
 * The user scope and the soft-delete predicate are seeded first and unconditional,
 * so no filter combination can widen the result past one account's live rows —
 * a filter must never become a way around the scope.
 */
function filtered(
  userId: string,
  filters: ExpenseFilters,
): { conditions: string[]; parameters: (string | string[])[] } {
  const conditions = ['e.user_id = $1', 'e.deleted_at IS NULL'];
  const parameters: (string | string[])[] = [userId];

  // AC-2: both bounds inclusive, so an expense dated exactly `from` or exactly
  // `to` is returned. `::date` casts the parameter, not the column, so the index
  // on (user_id, purchased_on DESC) stays usable.
  if (filters.from !== undefined) {
    parameters.push(filters.from);
    conditions.push(`e.purchased_on >= $${parameters.length}::date`);
  }

  if (filters.to !== undefined) {
    parameters.push(filters.to);
    conditions.push(`e.purchased_on <= $${parameters.length}::date`);
  }

  // AC-3: one id or many, the same way.
  if (filters.categoryIds !== undefined) {
    parameters.push(filters.categoryIds);
    conditions.push(`e.category_id = ANY($${parameters.length}::uuid[])`);
  }

  // AC-4. The only branch that adds SQL rather than a parameter — and it picks
  // between two fixed fragments, so nothing from the request reaches the string.
  if (filters.hasReceipt !== undefined) {
    conditions.push(
      filters.hasReceipt ? 'e.receipt_id IS NOT NULL' : 'e.receipt_id IS NULL',
    );
  }

  return { conditions, parameters };
}

/**
 * AC-11 and AC-1. Live expenses only, newest purchase first. With no filters the
 * query is the one this function has always run.
 */
export async function listExpenses(
  executor: Executor,
  userId: string,
  filters: ExpenseFilters = {},
): Promise<ExpenseRow[]> {
  const { conditions, parameters } = filtered(userId, filters);

  const { rows } = await executor.query<ExpenseRow>(
    `SELECT ${PROJECTION}
     ${FROM_EXPENSES}
     WHERE ${conditions.join(' AND ')}
     ORDER BY e.purchased_on DESC, e.created_at DESC, e.id DESC`,
    parameters,
  );

  return rows;
}

/**
 * EXP-20 AC-13. Where one export batch resumes from.
 *
 * `createdAt` is the **text** rendering of the column, not a Date, and that is
 * load-bearing. Postgres keeps `timestamptz` to microseconds while a JavaScript
 * Date holds milliseconds, so a cursor that round-tripped through a Date would
 * be marginally *earlier* than the row it came from — and the next batch would
 * return that row again. Rows written by one `INSERT ... generate_series` share
 * a millisecond and differ only in microseconds, so this is reachable, not
 * theoretical. Round-tripping the text Postgres printed is exact.
 */
export type ExpenseCursor = {
  purchasedOn: string;
  createdAt: string;
  id: string;
};

/** The cursor's own column, alongside the ordinary projection. */
export type ExpensePageRow = ExpenseRow & { created_at_text: string };

/**
 * EXP-20 AC-3 and AC-13. One keyset page, **oldest purchase first**.
 *
 * The reverse of `listExpenses` on purpose: a ledger reads forward in time, so
 * the export runs ascending while the list UI runs descending.
 *
 * Keyset rather than OFFSET, which would re-scan and re-sort everything already
 * emitted on every batch — quadratic over a long export — and would skip or
 * repeat rows if anything were written while it ran. The row-value comparison
 * `(a, b, c) > (x, y, z)` is evaluated left to right exactly as the ORDER BY
 * sorts, so the two can only agree.
 */
export async function listExpensePage(
  executor: Executor,
  userId: string,
  filters: ExpenseFilters,
  after: ExpenseCursor | undefined,
  limit: number,
): Promise<ExpensePageRow[]> {
  const { conditions, parameters } = filtered(userId, filters);

  if (after !== undefined) {
    const base = parameters.length;
    parameters.push(after.purchasedOn, after.createdAt, after.id);
    conditions.push(
      `(e.purchased_on, e.created_at, e.id)
       > ($${base + 1}::date, $${base + 2}::timestamptz, $${base + 3}::uuid)`,
    );
  }

  parameters.push(String(limit));

  const { rows } = await executor.query<ExpensePageRow>(
    `SELECT ${PROJECTION}, e.created_at::text AS created_at_text
     ${FROM_EXPENSES}
     WHERE ${conditions.join(' AND ')}
     ORDER BY e.purchased_on ASC, e.created_at ASC, e.id ASC
     LIMIT $${parameters.length}`,
    parameters,
  );

  return rows;
}

/**
 * AC-13. Scoped by `user_id`, which is what makes another user's id
 * indistinguishable from one that does not exist — neither matches a row, and
 * the route never learns which it was.
 */
export async function findExpenseById(
  executor: Executor,
  userId: string,
  id: string,
): Promise<ExpenseRow | undefined> {
  const { rows } = await executor.query<ExpenseRow>(
    `SELECT ${PROJECTION}
     ${FROM_EXPENSES}
     WHERE e.id = $1 AND e.user_id = $2 AND e.deleted_at IS NULL`,
    [id, userId],
  );

  return rows[0];
}

export type InsertExpenseOutcome =
  | { status: 'created'; expense: ExpenseRow }
  | { status: 'receipt-taken' };

/**
 * AC-4 and AC-10. The 409 comes from the partial unique index rather than a
 * prior SELECT, so two confirmations of the same receipt arriving together
 * cannot both create an expense.
 *
 * A CTE rather than a plain `RETURNING`, because the response needs the
 * category's name and `RETURNING` cannot join.
 */
export async function insertExpense(
  executor: Executor,
  userId: string,
  values: CreateExpenseValues,
): Promise<InsertExpenseOutcome> {
  const entries = entriesOf(values);
  const columns = ['user_id', ...entries.map(([field]) => COLUMN_FOR[field])];
  const parameters = [userId, ...entries.map(([, value]) => value)];

  try {
    const { rows } = await executor.query<ExpenseRow>(
      `WITH inserted AS (
         INSERT INTO expenses (${columns.join(', ')})
         VALUES (${parameters.map((_, index) => `$${index + 1}`).join(', ')})
         RETURNING *
       )
       SELECT ${PROJECTION} FROM inserted e JOIN categories c ON c.id = e.category_id`,
      parameters,
    );

    return { status: 'created', expense: rows[0] as ExpenseRow };
  } catch (error) {
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      return { status: 'receipt-taken' };
    }
    throw error;
  }
}

export type UpdateExpenseOutcome =
  | { status: 'updated'; expense: ExpenseRow }
  | { status: 'receipt-taken' }
  | { status: 'not-found' };

/**
 * AC-14 and AC-15. Only the columns named in `patch` appear in the SET clause;
 * an explicit null clears that one field and nothing else.
 *
 * The caller must not pass an empty patch — the route answers such a request
 * from `findExpenseById` instead, so a no-op does not bump `updated_at`.
 */
export async function updateExpense(
  executor: Executor,
  userId: string,
  id: string,
  patch: ExpenseInput,
): Promise<UpdateExpenseOutcome> {
  const entries = entriesOf(patch);
  const assignments = entries.map(
    ([field], index) => `${COLUMN_FOR[field]} = $${index + 3}`,
  );
  const parameters = [id, userId, ...entries.map(([, value]) => value)];

  try {
    const { rows } = await executor.query<ExpenseRow>(
      `WITH updated AS (
         UPDATE expenses
         SET ${[...assignments, 'updated_at = now()'].join(', ')}
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
         RETURNING *
       )
       SELECT ${PROJECTION} FROM updated e JOIN categories c ON c.id = e.category_id`,
      parameters,
    );

    const row = rows[0];

    if (!row) {
      return { status: 'not-found' };
    }

    return { status: 'updated', expense: row };
  } catch (error) {
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      return { status: 'receipt-taken' };
    }
    throw error;
  }
}

/**
 * AC-16 and AC-17. Soft only. The row stays for the same reason a receipt's
 * bytes do — this is a tax record — and because the partial unique index
 * ignores deleted rows, the receipt it held is immediately free to be confirmed
 * again.
 */
export async function softDeleteExpense(
  executor: Executor,
  userId: string,
  id: string,
): Promise<{ status: 'deleted' } | { status: 'not-found' }> {
  const { rows } = await executor.query<{ id: string }>(
    `UPDATE expenses
     SET deleted_at = now(), updated_at = now()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [id, userId],
  );

  return rows[0] ? { status: 'deleted' } : { status: 'not-found' };
}

/**
 * AC-19. The live expense holding each of the given receipts.
 *
 * Lives here rather than in `receipts/receipts.ts` because it reads the
 * `expenses` table; the receipt routes import it.
 */
export async function liveExpenseIdsFor(
  executor: Executor,
  receiptIds: string[],
): Promise<Map<string, string>> {
  if (receiptIds.length === 0) {
    return new Map();
  }

  const { rows } = await executor.query<{ receipt_id: string; id: string }>(
    `SELECT receipt_id, id
     FROM expenses
     WHERE receipt_id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    [receiptIds],
  );

  return new Map(rows.map((row) => [row.receipt_id, row.id]));
}

/** AC-18 and AC-19. Whether one receipt is already confirmed. */
export async function liveExpenseIdFor(
  executor: Executor,
  receiptId: string,
): Promise<string | null> {
  const found = await liveExpenseIdsFor(executor, [receiptId]);

  return found.get(receiptId) ?? null;
}
