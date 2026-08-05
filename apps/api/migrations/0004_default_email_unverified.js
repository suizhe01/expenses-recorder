/**
 * EXP-9 / AC-7 — turn the verification gate on for new accounts only.
 *
 * Order matters. Existing rows are set to true FIRST, then the default flips
 * to false. Doing it the other way, or flipping without a backfill, would lock
 * every existing account out the moment the gate lands — they have no
 * verification email to open and no way to get one except the resend endpoint.
 *
 * Only the default changes, never existing data, so this is safe to run on a
 * database with real accounts.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.sql('UPDATE users SET email_verified = true WHERE email_verified = false');
  pgm.alterColumn('users', 'email_verified', { default: false });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const down = (pgm) => {
  // Restores the previous default. Rows are deliberately left as they are:
  // rolling back must not un-verify an account that genuinely verified.
  pgm.alterColumn('users', 'email_verified', { default: true });
};
