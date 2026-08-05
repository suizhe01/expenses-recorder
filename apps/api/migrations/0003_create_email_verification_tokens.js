/**
 * EXP-8 / AC-1 — storage for email verification links.
 *
 * Tokens are stored hashed, never in plaintext, for the same reason as
 * `sessions.token_hash`: a database dump must not yield working links.
 *
 * `consumed_at` does double duty. It marks a link as spent after use, and it
 * is also how superseding works — issuing a new token stamps every earlier
 * unconsumed one, so only the newest link is ever live (AC-5).
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.createTable('email_verification_tokens', {
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
    token_hash: {
      type: 'text',
      notNull: true,
      unique: true,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    expires_at: {
      type: 'timestamptz',
      notNull: true,
    },
    consumed_at: {
      type: 'timestamptz',
      notNull: false,
    },
  });

  // Both the throttle check and the supersede-on-issue query filter by user.
  pgm.createIndex('email_verification_tokens', 'user_id');
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const down = (pgm) => {
  pgm.dropTable('email_verification_tokens');
};
