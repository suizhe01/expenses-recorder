import type { Executor } from '../auth/sessions.js';

/** Postgres unique-violation, raised by the partial index on live names. */
const UNIQUE_VIOLATION = '23505';

/**
 * AC-2 and AC-4 — what every account starts with. Kept in step with the same
 * list in `migrations/0006_create_categories.js`, which seeds accounts that
 * predate the table.
 *
 * None of these is special: all nine can be renamed or deleted like any other
 * (EXP-12 interview). There is deliberately no protected "Other".
 */
export const DEFAULT_CATEGORIES = [
  'Food',
  'Groceries',
  'Transport',
  'Medical',
  'Education',
  'Utilities',
  'Shopping',
  'Entertainment',
  'Other',
] as const;

export type CategoryRow = {
  id: string;
  user_id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

export type Category = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export function toCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * AC-2. Called with the transaction client that inserted the user, so an
 * account can never exist without its categories — and so a failed seed rolls
 * the registration back rather than leaving a half-made account.
 */
export async function seedDefaultCategories(
  client: Executor,
  userId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO categories (user_id, name)
     SELECT $1, name FROM unnest($2::text[]) AS name`,
    [userId, [...DEFAULT_CATEGORIES]],
  );
}

/** AC-5. Live categories only, alphabetical. */
export async function listCategories(
  executor: Executor,
  userId: string,
): Promise<CategoryRow[]> {
  const { rows } = await executor.query<CategoryRow>(
    `SELECT id, user_id, name, created_at, updated_at, deleted_at
     FROM categories
     WHERE user_id = $1 AND deleted_at IS NULL
     ORDER BY name`,
    [userId],
  );

  return rows;
}

export type CreateOutcome =
  | { status: 'created'; category: CategoryRow }
  | { status: 'conflict' };

/**
 * AC-6 to AC-8. Relies on the partial unique index rather than a prior SELECT,
 * so two simultaneous creates of the same name cannot both succeed, and so a
 * name whose only match is soft-deleted inserts cleanly.
 */
export async function createCategory(
  executor: Executor,
  userId: string,
  name: string,
): Promise<CreateOutcome> {
  try {
    const { rows } = await executor.query<CategoryRow>(
      `INSERT INTO categories (user_id, name)
       VALUES ($1, $2)
       RETURNING id, user_id, name, created_at, updated_at, deleted_at`,
      [userId, name],
    );

    return { status: 'created', category: rows[0] as CategoryRow };
  } catch (error) {
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      return { status: 'conflict' };
    }
    throw error;
  }
}

export type RenameOutcome =
  | { status: 'renamed'; category: CategoryRow }
  | { status: 'conflict' }
  | { status: 'not-found' };

/**
 * AC-9 and AC-11. Scoping the UPDATE by `user_id` is what makes another user's
 * id indistinguishable from one that does not exist — no row matches either
 * way, so both produce `not-found` without the route ever learning which.
 *
 * Renaming a category to its own current name in a different case does not
 * violate the index: the only conflicting row would be itself.
 */
export async function renameCategory(
  executor: Executor,
  userId: string,
  id: string,
  name: string,
): Promise<RenameOutcome> {
  try {
    const { rows } = await executor.query<CategoryRow>(
      `UPDATE categories
       SET name = $3, updated_at = now()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING id, user_id, name, created_at, updated_at, deleted_at`,
      [id, userId, name],
    );

    const row = rows[0];

    if (!row) {
      return { status: 'not-found' };
    }

    return { status: 'renamed', category: row };
  } catch (error) {
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      return { status: 'conflict' };
    }
    throw error;
  }
}

/**
 * AC-10. Soft only — the row is never removed, so an expense recorded against
 * it years ago still reads "Medical" rather than a dangling id.
 *
 * `deleted_at IS NULL` in the predicate means deleting twice reports
 * `not-found` on the second attempt, matching an unknown id.
 */
export async function softDeleteCategory(
  executor: Executor,
  userId: string,
  id: string,
): Promise<{ status: 'deleted' } | { status: 'not-found' }> {
  const { rows } = await executor.query<{ id: string }>(
    `UPDATE categories
     SET deleted_at = now(), updated_at = now()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [id, userId],
  );

  return rows[0] ? { status: 'deleted' } : { status: 'not-found' };
}
