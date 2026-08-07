/**
 * EXP-12 / AC-1 and AC-4 — user-owned expense categories.
 *
 * `name` is citext for the same reason `users.email` is: case-insensitive
 * uniqueness without a functional index, so Food and food cannot both be live.
 *
 * The unique index is **partial**, covering only rows where `deleted_at IS
 * NULL`. That is what lets a deleted name be used again (AC-8): the old row
 * keeps its name so historical expenses stay labelled, while a new row can
 * claim the same name. A total unique index would silently burn every name the
 * user ever deleted.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/** The defaults every account starts with (AC-2, AC-4). */
const DEFAULT_CATEGORIES = [
  'Food',
  'Groceries',
  'Transport',
  'Medical',
  'Education',
  'Utilities',
  'Shopping',
  'Entertainment',
  'Other',
];

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.createTable('categories', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    name: {
      type: 'citext',
      notNull: true,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    deleted_at: {
      type: 'timestamptz',
      notNull: false,
    },
  });

  // AC-1: uniqueness applies only among live rows. See the note above.
  pgm.createIndex('categories', ['user_id', 'name'], {
    unique: true,
    where: 'deleted_at IS NULL',
    name: 'categories_user_id_name_live_unique',
  });

  // Every read is scoped to one user.
  pgm.createIndex('categories', 'user_id');

  // AC-4: seed accounts that predate this table.
  //
  // Scoped by NOT EXISTS rather than by a timestamp or an unconditional
  // insert. Re-running this migration on a database where users already have
  // categories inserts nothing, because every such user fails the predicate.
  // EXP-9's backfill was unscoped and marked every pending signup verified;
  // this is the same class of mistake, so it is prevented structurally rather
  // than by remembering not to re-run.
  const values = DEFAULT_CATEGORIES.map((name) => `('${name}')`).join(', ');

  pgm.sql(`
    INSERT INTO categories (user_id, name)
    SELECT u.id, d.name
    FROM users u
    CROSS JOIN (VALUES ${values}) AS d(name)
    WHERE NOT EXISTS (
      SELECT 1 FROM categories c WHERE c.user_id = u.id
    )
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const down = (pgm) => {
  pgm.dropTable('categories');
};
