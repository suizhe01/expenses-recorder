/**
 * EXP-10 / AC-1 — storage for password reset links.
 *
 * Deliberately a separate table from `email_verification_tokens` rather than a
 * `purpose` column on it. The two have different lifetimes (1 hour against 24)
 * and independent throttles (AC-4), and keeping them apart means a query for
 * one can never accidentally supersede or consume the other.
 *
 * Tokens are stored hashed, never in plaintext, for the same reason as
 * `sessions.token_hash`: a database dump must not yield working links. The
 * stakes are higher here — a verification link confirms an address, a reset
 * link takes over an account.
 *
 * `consumed_at` does double duty exactly as it does in `0003`. It marks a link
 * as spent after use, and it is also how superseding works — issuing a new
 * token stamps every earlier unconsumed one, so only the newest link is ever
 * live (AC-3).
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.createTable('password_reset_tokens', {
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
  pgm.createIndex('password_reset_tokens', 'user_id');
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const down = (pgm) => {
  pgm.dropTable('password_reset_tokens');
};
