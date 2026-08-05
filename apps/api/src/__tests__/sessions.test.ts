import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { createDatabase, type Database } from '../db.js';
import {
  createSession,
  generateRefreshToken,
  pruneSessions,
  REVOKED_RETENTION_MS,
} from '../auth/sessions.js';

const config = parseConfig({
  ...process.env,
  JWT_SECRET: 'test-secret-at-least-thirty-two-chars',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  LOG_LEVEL: 'silent',
});

const DAY_MS = 24 * 60 * 60 * 1_000;

let database: Database;
let userId: string;

beforeAll(async () => {
  database = createDatabase(config);
  await database.pool.query('SELECT 1 FROM sessions LIMIT 0');
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.pool.query('TRUNCATE users CASCADE');

  const { rows } = await database.pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
    ['prune@x.com', 'scrypt$16384$8$1$aaaa$bbbb'],
  );
  userId = rows[0]!.id;
});

/** Creates a session and forces it into a specific state and age. */
async function seed(
  label: string,
  patch: { expiresAt?: Date; revokedAt?: Date },
): Promise<string> {
  const session = await createSession(
    database.pool,
    userId,
    `${generateRefreshToken()}-${label}`,
  );

  if (patch.expiresAt) {
    await database.pool.query('UPDATE sessions SET expires_at = $2 WHERE id = $1', [
      session.id,
      patch.expiresAt,
    ]);
  }

  if (patch.revokedAt) {
    await database.pool.query('UPDATE sessions SET revoked_at = $2 WHERE id = $1', [
      session.id,
      patch.revokedAt,
    ]);
  }

  return session.id;
}

async function survivingIds(): Promise<string[]> {
  const { rows } = await database.pool.query<{ id: string }>('SELECT id FROM sessions');
  return rows.map((r) => r.id);
}

describe('pruneSessions', () => {
  // AC-3
  it('deletes expired rows and revoked rows past the retention window only', async () => {
    const now = new Date();

    const expiredYesterday = await seed('expired', {
      expiresAt: new Date(now.getTime() - DAY_MS),
    });
    const revokedLongAgo = await seed('old-revoked', {
      revokedAt: new Date(now.getTime() - REVOKED_RETENTION_MS - DAY_MS),
    });
    const revokedRecently = await seed('new-revoked', {
      revokedAt: new Date(now.getTime() - DAY_MS),
    });
    const live = await seed('live', {});

    const result = await pruneSessions(database.pool, now);

    expect(result.expired).toBe(1);
    expect(result.revoked).toBe(1);

    const remaining = await survivingIds();
    expect(remaining).toHaveLength(2);
    expect(remaining).toContain(revokedRecently);
    expect(remaining).toContain(live);
    expect(remaining).not.toContain(expiredYesterday);
    expect(remaining).not.toContain(revokedLongAgo);
  });

  // AC-3: the boundary itself. A row revoked exactly at the cutoff is kept,
  // because the comparison is strictly older-than.
  it('keeps a row revoked exactly at the retention boundary', async () => {
    const now = new Date();
    const atBoundary = await seed('boundary', {
      revokedAt: new Date(now.getTime() - REVOKED_RETENTION_MS),
    });

    const result = await pruneSessions(database.pool, now);

    expect(result.revoked).toBe(0);
    expect(await survivingIds()).toContain(atBoundary);
  });

  it('does not delete a live session that has never been revoked', async () => {
    const live = await seed('live', {});

    const result = await pruneSessions(database.pool, new Date());

    expect(result).toEqual({ expired: 0, revoked: 0 });
    expect(await survivingIds()).toEqual([live]);
  });

  // AC-4
  it('is a no-op on a second run', async () => {
    const now = new Date();
    await seed('expired', { expiresAt: new Date(now.getTime() - DAY_MS) });
    await seed('live', {});

    const first = await pruneSessions(database.pool, now);
    expect(first.expired).toBe(1);

    const second = await pruneSessions(database.pool, now);
    expect(second).toEqual({ expired: 0, revoked: 0 });
  });

  // An expired row that was also revoked must be counted once, not twice.
  it('counts a row that is both expired and revoked only once', async () => {
    const now = new Date();
    await seed('both', {
      expiresAt: new Date(now.getTime() - DAY_MS),
      revokedAt: new Date(now.getTime() - REVOKED_RETENTION_MS - DAY_MS),
    });

    const result = await pruneSessions(database.pool, now);

    expect(result.expired + result.revoked).toBe(1);
    expect(await survivingIds()).toHaveLength(0);
  });
});
