import { createHash, randomBytes } from 'node:crypto';
import type { Executor } from './sessions.js';

/** 24 hours — long enough to survive an email found the next morning. */
export const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1_000;

/** At most one verification email per account per minute (AC-4). */
export const RESEND_THROTTLE_MS = 60 * 1_000;

const TOKEN_BYTES = 32;

export type VerificationTokenRow = {
  id: string;
  user_id: string;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
};

/**
 * Verification tokens are opaque random strings; only their SHA-256 is
 * persisted. SHA-256 rather than scrypt is right here because the input is 256
 * bits of entropy — there is no dictionary to attack, only the full keyspace.
 */
export function generateVerificationToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashVerificationToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

/**
 * True when this account received a token within the throttle window, so a
 * further request must not create one or dispatch mail (AC-4).
 *
 * Reads the newest unconsumed token's `created_at` rather than tracking send
 * attempts separately — the row already records exactly what we need.
 */
export async function isThrottled(
  executor: Executor,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const { rows } = await executor.query<{ created_at: Date }>(
    `SELECT created_at
     FROM email_verification_tokens
     WHERE user_id = $1 AND consumed_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId],
  );

  const newest = rows[0];

  if (!newest) {
    return false;
  }

  return now.getTime() - newest.created_at.getTime() < RESEND_THROTTLE_MS;
}

/**
 * Issues a token, superseding any earlier unconsumed ones for that user so
 * only the newest link works (AC-5). Both statements run on the caller's
 * executor, so passing a transaction client makes them atomic.
 */
export async function createVerificationToken(
  executor: Executor,
  userId: string,
  token: string,
  now: Date = new Date(),
): Promise<VerificationTokenRow> {
  await executor.query(
    `UPDATE email_verification_tokens
     SET consumed_at = $2
     WHERE user_id = $1 AND consumed_at IS NULL`,
    [userId, now],
  );

  const expiresAt = new Date(now.getTime() + VERIFICATION_TOKEN_TTL_MS);

  const { rows } = await executor.query<VerificationTokenRow>(
    `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)
     RETURNING id, user_id, created_at, expires_at, consumed_at`,
    [userId, hashVerificationToken(token), expiresAt],
  );

  return rows[0] as VerificationTokenRow;
}

export async function findVerificationToken(
  executor: Executor,
  token: string,
): Promise<VerificationTokenRow | undefined> {
  const { rows } = await executor.query<VerificationTokenRow>(
    `SELECT id, user_id, created_at, expires_at, consumed_at
     FROM email_verification_tokens
     WHERE token_hash = $1`,
    [hashVerificationToken(token)],
  );

  return rows[0];
}

export type ConsumeOutcome =
  | { status: 'verified' }
  | { status: 'already-verified' }
  | { status: 'invalid' };

/**
 * Redeems a token: marks it consumed and flips the account to verified.
 *
 * The three outcomes map onto the three pages. `already-verified` is a
 * success, not an error — mail clients prefetch links and people double-tap,
 * so a spent token must not look like a failure (AC-7).
 */
export async function consumeVerificationToken(
  executor: Executor,
  token: string,
  now: Date = new Date(),
): Promise<ConsumeOutcome> {
  const row = await findVerificationToken(executor, token);

  if (!row) {
    return { status: 'invalid' };
  }

  if (row.consumed_at !== null) {
    return { status: 'already-verified' };
  }

  if (row.expires_at.getTime() <= now.getTime()) {
    return { status: 'invalid' };
  }

  await executor.query(
    `UPDATE email_verification_tokens SET consumed_at = $2 WHERE id = $1`,
    [row.id, now],
  );

  await executor.query(
    `UPDATE users SET email_verified = true, updated_at = $2 WHERE id = $1`,
    [row.user_id, now],
  );

  return { status: 'verified' };
}
