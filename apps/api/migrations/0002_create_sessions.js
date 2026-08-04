/**
 * EXP-6 / AC-1 — session storage for refresh tokens, plus the verification
 * seam.
 *
 * Refresh tokens are stored hashed, never in plaintext: a stolen database dump
 * must not yield usable tokens. Rotation is recorded by revoking the old row
 * and pointing `replaced_by` at its successor, which is what makes reuse
 * detection possible (AC-8).
 *
 * `users.email_verified` is created here but read by nothing (NG-1). It exists
 * so the following issue can gate login with a one-line default change rather
 * than a table rewrite.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.addColumn('users', {
    email_verified: {
      type: 'boolean',
      notNull: true,
      default: true,
    },
  });

  pgm.createTable('sessions', {
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
    // SHA-256 of the refresh token. Unique so a collision surfaces as an error
    // rather than silently authenticating the wrong session.
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
    revoked_at: {
      type: 'timestamptz',
      notNull: false,
    },
    replaced_by: {
      type: 'uuid',
      notNull: false,
      references: 'sessions',
      onDelete: 'SET NULL',
    },
  });

  // Reuse detection revokes every session for a user, so that lookup is on the
  // hot path for the one request that matters most.
  pgm.createIndex('sessions', 'user_id');
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const down = (pgm) => {
  pgm.dropTable('sessions');
  pgm.dropColumn('users', 'email_verified');
};
