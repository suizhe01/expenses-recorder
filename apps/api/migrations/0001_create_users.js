/**
 * EXP-5 / AC-4 — initial schema.
 *
 * Creates the `users` table only. Nothing writes to it in this issue (NG-1);
 * authentication lands in a later issue in the chain.
 *
 * Written as a JS migration rather than plain SQL because node-pg-migrate's
 * raw `.sql` migrations have no down() support, and AC-4 requires a working
 * `npm run migrate:down`.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  // citext gives case-insensitive uniqueness on email without a functional
  // index, so Foo@x.com and foo@x.com cannot both register.
  pgm.createExtension('citext', { ifNotExists: true });
  pgm.createExtension('pgcrypto', { ifNotExists: true });

  pgm.createTable('users', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    email: {
      type: 'citext',
      notNull: true,
      unique: true,
    },
    password_hash: {
      type: 'text',
      notNull: false,
    },
    google_sub: {
      type: 'text',
      notNull: false,
      unique: true,
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
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const down = (pgm) => {
  pgm.dropTable('users');
  // Extensions are intentionally left in place: they are database-wide and
  // may be in use by objects outside this migration.
};
