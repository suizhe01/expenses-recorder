import { createHash, randomBytes } from 'node:crypto';
import type { Executor } from './sessions.js';
import { revokeAllSessionsForUser } from './sessions.js';

/**
 * 1 hour — deliberately far shorter than the 24 hours a verification token
 * gets (AC-11). A verification link only confirms an address; a reset link
 * takes over an account, so it should sit in an inbox for as little time as
 * the flow allows.
 */
export const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1_000;

/** At most one reset email per account per minute (AC-3). */
export const RESET_THROTTLE_MS = 60 * 1_000;

const TOKEN_BYTES = 32;

export type PasswordResetTokenRow = {
  id: string;
  user_id: string;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
};

/**
 * Reset tokens are opaque random strings; only their SHA-256 is persisted.
 * SHA-256 rather than scrypt is right here for the same reason as
 * verification: the input is 256 bits of entropy, so there is no dictionary to
 * attack, only the full keyspace.
 */
export function generatePasswordResetToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashPasswordResetToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

/**
 * True when this account received a reset token within the throttle window.
 *
 * Reads only `password_reset_tokens`, never the verification table (AC-4). A
 * user who just triggered a verification email is very often the same user who
 * now needs a reset — they are stuck behind the login 403 — so letting one
 * throttle swallow the other would block the request they actually care about.
 */
export async function isResetThrottled(
  executor: Executor,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const { rows } = await executor.query<{ created_at: Date }>(
    `SELECT created_at
     FROM password_reset_tokens
     WHERE user_id = $1 AND consumed_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId],
  );

  const newest = rows[0];

  if (!newest) {
    return false;
  }

  return now.getTime() - newest.created_at.getTime() < RESET_THROTTLE_MS;
}

/**
 * Issues a token, superseding any earlier unconsumed ones for that user so
 * only the newest link works (AC-3). Both statements run on the caller's
 * executor, so passing a transaction client makes them atomic.
 */
export async function createPasswordResetToken(
  executor: Executor,
  userId: string,
  token: string,
  now: Date = new Date(),
): Promise<PasswordResetTokenRow> {
  await executor.query(
    `UPDATE password_reset_tokens
     SET consumed_at = $2
     WHERE user_id = $1 AND consumed_at IS NULL`,
    [userId, now],
  );

  const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TOKEN_TTL_MS);

  const { rows } = await executor.query<PasswordResetTokenRow>(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)
     RETURNING id, user_id, created_at, expires_at, consumed_at`,
    [userId, hashPasswordResetToken(token), expiresAt],
  );

  return rows[0] as PasswordResetTokenRow;
}

export async function findPasswordResetToken(
  executor: Executor,
  token: string,
): Promise<PasswordResetTokenRow | undefined> {
  const { rows } = await executor.query<PasswordResetTokenRow>(
    `SELECT id, user_id, created_at, expires_at, consumed_at
     FROM password_reset_tokens
     WHERE token_hash = $1`,
    [hashPasswordResetToken(token)],
  );

  return rows[0];
}

/**
 * Whether a token row can still be redeemed. Used by the GET to decide between
 * the form and the error page, and again inside the POST's transaction.
 *
 * Unlike verification, a spent reset token has no friendly "already done"
 * outcome: re-rendering the form for a consumed token would invite the user to
 * type a password that could never be saved.
 */
export function isRedeemable(
  row: PasswordResetTokenRow,
  now: Date = new Date(),
): boolean {
  return row.consumed_at === null && row.expires_at.getTime() > now.getTime();
}

export type RedeemOutcome = { status: 'reset' } | { status: 'invalid' };

/**
 * Redeems a token: consumes it, writes the new password, ends every session,
 * and marks the address verified.
 *
 * Must be called with a transaction client. The four writes are one unit — a
 * password changed without the sessions being revoked would leave a thief
 * logged in on the account they were just locked out of.
 *
 * The consuming UPDATE is conditional on `consumed_at IS NULL` and reports how
 * many rows it touched, which is what makes AC-14 hold: two simultaneous
 * submits both pass the earlier validity check, but only one can match that
 * predicate, and the loser writes nothing at all.
 */
export async function redeemPasswordResetToken(
  client: Executor,
  token: string,
  passwordHash: string,
  now: Date = new Date(),
): Promise<RedeemOutcome> {
  const { rows } = await client.query<{ user_id: string }>(
    `UPDATE password_reset_tokens
     SET consumed_at = $2
     WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > $2
     RETURNING user_id`,
    [hashPasswordResetToken(token), now],
  );

  const claimed = rows[0];

  if (!claimed) {
    return { status: 'invalid' };
  }

  // AC-7: redeeming a link delivered to the address proves control of the
  // mailbox, which is exactly what a verification link proves. Setting it here
  // is what stops a user who never verified and then forgot their password
  // from being stranded behind the login 403 with no way through.
  await client.query(
    `UPDATE users
     SET password_hash = $2, email_verified = true, updated_at = $3
     WHERE id = $1`,
    [claimed.user_id, passwordHash, now],
  );

  // AC-7: reset is the recovery path for an account that may be compromised,
  // so every refresh token dies with it. Leaving them alive would let whoever
  // prompted the reset keep the access it was performed to remove.
  await revokeAllSessionsForUser(client, claimed.user_id);

  return { status: 'reset' };
}
