/**
 * EXP-9 / AC-7, AC-7b — turn the verification gate on for new accounts only.
 *
 * Accounts that predate the gate are grandfathered to verified before the
 * default flips. Without that, the deploy would lock out every existing user:
 * they have no verification email to open and no way to get one except the
 * resend endpoint.
 *
 * The cutoff is recorded in `email_verification_gate` at first application and
 * is deliberately NOT removed by `down`. That is what makes `up` idempotent.
 *
 * `down` restores only the default and never touches data, so `down` followed
 * by `up` is an ordinary rollback-and-roll-forward. An unscoped backfill would
 * then mark every signup currently awaiting its link as verified — silently
 * disabling the gate for exactly the accounts it exists to hold back, and
 * letting them log in without ever proving they own the address. Scoping to
 * rows older than the recorded cutoff keeps the re-run a no-op.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  // Single-row table: the CHECK plus the primary key make a second row
  // impossible, so the cutoff can never be ambiguous.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS email_verification_gate (
      id boolean PRIMARY KEY DEFAULT true,
      applied_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT email_verification_gate_singleton CHECK (id)
    )
  `);

  // Records the cutoff on first application only. On a re-run the original
  // timestamp is preserved, which is the whole point.
  pgm.sql(`
    INSERT INTO email_verification_gate (id) VALUES (true)
    ON CONFLICT (id) DO NOTHING
  `);

  pgm.sql(`
    UPDATE users
    SET email_verified = true
    WHERE email_verified = false
      AND created_at < (SELECT applied_at FROM email_verification_gate)
  `);

  pgm.alterColumn('users', 'email_verified', { default: false });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const down = (pgm) => {
  // Restores the previous default. Rows are deliberately left as they are:
  // rolling back must not un-verify an account that genuinely verified.
  //
  // `email_verification_gate` is deliberately kept too. Dropping it would let a
  // later `up` re-record a fresh cutoff and sweep up every pending account.
  pgm.alterColumn('users', 'email_verified', { default: true });
};
