import { createHash, randomBytes } from 'node:crypto';
import type { Executor } from '../auth/sessions.js';

/** A URL token needs only enough time for the browser to start its request. */
export const DOWNLOAD_TOKEN_TTL_MS = 60 * 1_000;
const TOKEN_BYTES = 32;

export type DownloadToken = {
  token: string;
  expiresAt: Date;
};

export function generateDownloadToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashDownloadToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

export async function createDownloadToken(
  executor: Executor,
  userId: string,
  token: string = generateDownloadToken(),
  now: Date = new Date(),
): Promise<DownloadToken> {
  const expiresAt = new Date(now.getTime() + DOWNLOAD_TOKEN_TTL_MS);

  await executor.query(
    `INSERT INTO download_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, hashDownloadToken(token), expiresAt],
  );

  return { token, expiresAt };
}

/**
 * Claims a token in the same statement that checks its lifetime and prior use.
 * A second concurrent caller finds no matching row once the first succeeds.
 */
export async function redeemDownloadToken(
  executor: Executor,
  token: string,
): Promise<string | undefined> {
  const { rows } = await executor.query<{ user_id: string }>(
    `UPDATE download_tokens
     SET used_at = now()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [hashDownloadToken(token)],
  );

  return rows[0]?.user_id;
}

export async function pruneDownloadTokens(
  executor: Executor,
  now: Date = new Date(),
): Promise<number> {
  const result = await executor.query(
    `DELETE FROM download_tokens
     WHERE used_at IS NOT NULL OR expires_at < $1`,
    [now],
  );

  return result.rowCount ?? 0;
}
