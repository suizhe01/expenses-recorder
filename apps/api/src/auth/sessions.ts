import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';

/** 90 days, per the issue's chosen refresh lifetime. */
export const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1_000;

const TOKEN_BYTES = 32;

export type SessionRow = {
  id: string;
  user_id: string;
  expires_at: Date;
  revoked_at: Date | null;
  /**
   * Set only when this session was superseded by a refresh. It is what
   * distinguishes a rotated token (replaying it signals theft) from one
   * revoked by an explicit logout (replaying it is just a stale client).
   */
  replaced_by: string | null;
};

/**
 * Refresh tokens are opaque random strings. Only their SHA-256 is persisted,
 * so a database dump yields nothing usable. SHA-256 is appropriate here (and
 * scrypt is not) because the input is 256 bits of entropy — there is no
 * dictionary to attack.
 */
export function generateRefreshToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

export type Executor = Pick<pg.Pool, 'query'> | pg.PoolClient;

export async function createSession(
  executor: Executor,
  userId: string,
  token: string,
  now: Date = new Date(),
): Promise<SessionRow> {
  const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);

  const { rows } = await executor.query<SessionRow>(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)
     RETURNING id, user_id, expires_at, revoked_at, replaced_by`,
    [userId, hashRefreshToken(token), expiresAt],
  );

  return rows[0] as SessionRow;
}

export async function findSessionByToken(
  executor: Executor,
  token: string,
): Promise<SessionRow | undefined> {
  const { rows } = await executor.query<SessionRow>(
    `SELECT id, user_id, expires_at, revoked_at, replaced_by
     FROM sessions
     WHERE token_hash = $1`,
    [hashRefreshToken(token)],
  );

  return rows[0];
}

export async function revokeSession(
  executor: Executor,
  sessionId: string,
): Promise<void> {
  await executor.query(
    `UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId],
  );
}

/**
 * AC-8: presenting an already-rotated token means it leaked, and there is no
 * way to tell whether the legitimate client or the thief is holding the
 * current one. Killing every session forces a re-login on all devices.
 */
export async function revokeAllSessionsForUser(
  executor: Executor,
  userId: string,
): Promise<void> {
  await executor.query(
    `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
}

export async function markReplaced(
  executor: Executor,
  oldSessionId: string,
  newSessionId: string,
): Promise<void> {
  await executor.query(
    `UPDATE sessions SET revoked_at = now(), replaced_by = $2 WHERE id = $1`,
    [oldSessionId, newSessionId],
  );
}

export function isUsable(session: SessionRow, now: Date = new Date()): boolean {
  return session.revoked_at === null && session.expires_at.getTime() > now.getTime();
}
