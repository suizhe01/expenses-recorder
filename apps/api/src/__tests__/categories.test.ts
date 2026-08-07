import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { parseConfig } from '../config.js';
import { createDatabase, type Database } from '../db.js';
import type { EmailTransport } from '../email/transport.js';
import { DEFAULT_CATEGORIES } from '../categories/categories.js';

const config = parseConfig({
  ...process.env,
  JWT_SECRET: 'test-secret-at-least-thirty-two-chars',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  LOG_LEVEL: 'silent',
});

const PASSWORD = 'correcthorsebattery';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

let database: Database;
let app: FastifyInstance;

/**
 * Registration dispatches a verification email, and these tests register a
 * lot. Without an explicit transport `buildApp` picks Resend whenever a real
 * `RESEND_API_KEY` is present in the environment, so a local run would fire
 * dozens of live API calls at example.com addresses. Nothing here asserts on
 * email, so the transport does nothing at all.
 */
const silentTransport: EmailTransport = {
  name: 'silent',
  sendVerificationEmail: async () => {},
  sendPasswordResetEmail: async () => {},
};

beforeAll(async () => {
  database = createDatabase(config);
  await database.pool.query('SELECT 1 FROM categories LIMIT 0');
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.pool.query('TRUNCATE users CASCADE');
  app = buildApp({ config, database, emailTransport: silentTransport });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

type Account = { token: string; userId: string };

/** Registers, clears the verification gate, and logs in for an access token. */
async function account(email: string): Promise<Account> {
  await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password: PASSWORD },
  });

  await database.pool.query('UPDATE users SET email_verified = true WHERE email = $1', [
    email,
  ]);

  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });

  const { rows } = await database.pool.query<{ id: string }>(
    'SELECT id FROM users WHERE email = $1',
    [email],
  );

  return {
    token: (login.json() as { accessToken: string }).accessToken,
    userId: rows[0]!.id,
  };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

function list(token: string) {
  return app.inject({ method: 'GET', url: '/categories', headers: auth(token) });
}

function create(token: string, name: unknown) {
  return app.inject({
    method: 'POST',
    url: '/categories',
    headers: auth(token),
    payload: { name },
  });
}

function rename(token: string, id: string, name: string) {
  return app.inject({
    method: 'PATCH',
    url: `/categories/${id}`,
    headers: auth(token),
    payload: { name },
  });
}

function remove(token: string, id: string) {
  return app.inject({
    method: 'DELETE',
    url: `/categories/${id}`,
    headers: auth(token),
  });
}

function names(response: { json: () => unknown }): string[] {
  return (response.json() as { name: string }[]).map((c) => c.name);
}

function countFor(userId: string) {
  return database.pool
    .query<{ count: string }>('SELECT count(*) FROM categories WHERE user_id = $1', [
      userId,
    ])
    .then((r) => Number(r.rows[0]!.count));
}

describe('schema', () => {
  it('AC-1: uniqueness is enforced only over live rows', async () => {
    const { rows } = await database.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'categories' AND indexname = 'categories_user_id_name_live_unique'`,
    );

    expect(rows[0]?.indexdef).toContain('UNIQUE');
    expect(rows[0]?.indexdef).toContain('WHERE (deleted_at IS NULL)');
  });
});

describe('seeding', () => {
  it('AC-4: the migration itself scopes the backfill', async () => {
    // The idempotency test below replays the statement rather than running the
    // migration, so on its own it would not notice this guard being deleted
    // from the file. EXP-9 shipped exactly that mistake.
    const sql = await readFile(
      new URL('../../migrations/0006_create_categories.js', import.meta.url),
      'utf8',
    );

    expect(sql).toContain('WHERE NOT EXISTS');
  });

  it('AC-2: registration creates the nine defaults', async () => {
    const { token, userId } = await account('seed@example.com');

    expect(await countFor(userId)).toBe(9);
    expect(names(await list(token)).sort()).toEqual([...DEFAULT_CATEGORIES].sort());
  });

  it('AC-3: a taken address changes nothing and answers identically', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'dup@example.com', password: PASSWORD },
    });

    const { rows } = await database.pool.query<{ id: string }>(
      'SELECT id FROM users WHERE email = $1',
      ['dup@example.com'],
    );
    const userId = rows[0]!.id;
    expect(await countFor(userId)).toBe(9);

    const second = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'dup@example.com', password: 'a-completely-different-one' },
    });

    expect(second.statusCode).toBe(first.statusCode);
    expect(second.body).toBe(first.body);

    // Seeding must not have run a second time, and the rollback must have left
    // exactly the original nine.
    expect(await countFor(userId)).toBe(9);
    const total = await database.pool.query<{ count: string }>(
      'SELECT count(*) FROM categories',
    );
    expect(Number(total.rows[0]!.count)).toBe(9);
  });

  it('AC-4: the backfill inserts nothing on a second run', async () => {
    const { userId } = await account('backfill@example.com');

    // The exact statement migration 0006 runs, replayed.
    const backfill = `
      INSERT INTO categories (user_id, name)
      SELECT u.id, d.name
      FROM users u
      CROSS JOIN (VALUES ${DEFAULT_CATEGORIES.map((n) => `('${n}')`).join(', ')}) AS d(name)
      WHERE NOT EXISTS (SELECT 1 FROM categories c WHERE c.user_id = u.id)
    `;

    const first = await database.pool.query(backfill);
    expect(first.rowCount).toBe(0);

    const second = await database.pool.query(backfill);
    expect(second.rowCount).toBe(0);

    expect(await countFor(userId)).toBe(9);
  });

  it('AC-4: the backfill seeds an account that has none', async () => {
    const { userId } = await account('empty@example.com');
    await database.pool.query('DELETE FROM categories WHERE user_id = $1', [userId]);

    await database.pool.query(`
      INSERT INTO categories (user_id, name)
      SELECT u.id, d.name
      FROM users u
      CROSS JOIN (VALUES ${DEFAULT_CATEGORIES.map((n) => `('${n}')`).join(', ')}) AS d(name)
      WHERE NOT EXISTS (SELECT 1 FROM categories c WHERE c.user_id = u.id)
    `);

    expect(await countFor(userId)).toBe(9);
  });
});

describe('GET /categories', () => {
  it('AC-5: returns live categories alphabetically', async () => {
    const { token } = await account('list@example.com');

    const response = await list(token);

    expect(response.statusCode).toBe(200);
    const returned = names(response);
    expect(returned).toEqual([...returned].sort((a, b) => a.localeCompare(b)));
  });

  it('AC-5: an account with none returns an empty array', async () => {
    const { token, userId } = await account('none@example.com');
    await database.pool.query('DELETE FROM categories WHERE user_id = $1', [userId]);

    const response = await list(token);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it('AC-5: soft-deleted categories are excluded', async () => {
    const { token } = await account('hide@example.com');
    const created = await create(token, 'Coffee');
    const { id } = created.json() as { id: string };

    await remove(token, id);

    expect(names(await list(token))).not.toContain('Coffee');
  });
});

describe('POST /categories', () => {
  it('AC-6: creates a category and trims the name', async () => {
    const { token } = await account('create@example.com');

    const response = await create(token, '  Coffee  ');

    expect(response.statusCode).toBe(201);
    expect((response.json() as { name: string }).name).toBe('Coffee');
  });

  it('AC-6: rejects empty, whitespace-only, and over-long names', async () => {
    const { token } = await account('bad@example.com');

    for (const value of ['', '   ', 'x'.repeat(51)]) {
      const response = await create(token, value);
      expect(response.statusCode).toBe(400);
      expect((response.json() as { fields: Record<string, string> }).fields).toHaveProperty(
        'name',
      );
    }
  });

  it('AC-7: refuses a live name, ignoring case, and writes nothing', async () => {
    const { token, userId } = await account('dupe@example.com');
    const before = await countFor(userId);

    expect((await create(token, 'Food')).statusCode).toBe(409);
    expect((await create(token, 'food')).statusCode).toBe(409);
    expect((await create(token, 'FOOD')).statusCode).toBe(409);

    expect(await countFor(userId)).toBe(before);
  });

  it('AC-8: a name whose only match is deleted can be reused', async () => {
    const { token } = await account('reuse@example.com');

    const first = await create(token, 'Coffee');
    const firstId = (first.json() as { id: string }).id;
    await remove(token, firstId);

    const second = await create(token, 'Coffee');

    expect(second.statusCode).toBe(201);
    const secondId = (second.json() as { id: string }).id;
    expect(secondId).not.toBe(firstId);

    // Both rows survive; only the newer one is live.
    const { rows } = await database.pool.query<{ id: string; deleted_at: Date | null }>(
      `SELECT id, deleted_at FROM categories WHERE name = 'Coffee' ORDER BY created_at`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.deleted_at).not.toBeNull();
    expect(rows[1]!.deleted_at).toBeNull();
  });
});

describe('PATCH /categories/:id', () => {
  async function firstCategory(token: string) {
    return (await list(token)).json() as { id: string; name: string }[];
  }

  it('AC-9: renames and returns the updated category', async () => {
    const { token } = await account('rename@example.com');
    const [target] = await firstCategory(token);

    const response = await rename(token, target!.id, 'Renamed');

    expect(response.statusCode).toBe(200);
    expect((response.json() as { name: string }).name).toBe('Renamed');
    expect(names(await list(token))).toContain('Renamed');
  });

  it('AC-9: refuses a name another live category already holds', async () => {
    const { token } = await account('clash@example.com');
    const categories = await firstCategory(token);
    const target = categories.find((c) => c.name === 'Food')!;

    expect((await rename(token, target.id, 'Transport')).statusCode).toBe(409);
    expect((await rename(token, target.id, 'transport')).statusCode).toBe(409);
  });

  it('AC-9: renaming to its own name in another case is allowed', async () => {
    const { token } = await account('samename@example.com');
    const categories = await firstCategory(token);
    const target = categories.find((c) => c.name === 'Food')!;

    const response = await rename(token, target.id, 'FOOD');

    expect(response.statusCode).toBe(200);
    expect((response.json() as { name: string }).name).toBe('FOOD');
  });
});

describe('DELETE /categories/:id', () => {
  it('AC-10: soft deletes, keeps the row, and refuses a second attempt', async () => {
    const { token } = await account('del@example.com');
    const created = await create(token, 'Coffee');
    const { id } = created.json() as { id: string };

    const first = await remove(token, id);
    expect(first.statusCode).toBe(204);

    const { rows } = await database.pool.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM categories WHERE id = $1',
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deleted_at).not.toBeNull();

    expect((await remove(token, id)).statusCode).toBe(404);
  });
});

describe('ownership', () => {
  it("AC-11: another user's id is indistinguishable from one that does not exist", async () => {
    const mine = await account('mine@example.com');
    const theirs = await account('theirs@example.com');

    const theirCategories = (await list(theirs.token)).json() as { id: string }[];
    const theirId = theirCategories[0]!.id;

    const patchTheirs = await rename(mine.token, theirId, 'Stolen');
    const patchUnknown = await rename(mine.token, UNKNOWN_ID, 'Stolen');
    expect(patchTheirs.statusCode).toBe(404);
    expect(patchTheirs.body).toBe(patchUnknown.body);

    const deleteTheirs = await remove(mine.token, theirId);
    const deleteUnknown = await remove(mine.token, UNKNOWN_ID);
    expect(deleteTheirs.statusCode).toBe(404);
    expect(deleteTheirs.body).toBe(deleteUnknown.body);

    // And nothing of theirs was touched.
    expect(await countFor(theirs.userId)).toBe(9);
  });

  it('AC-11: a malformed id answers the same 404', async () => {
    const { token } = await account('malformed@example.com');

    const bad = await remove(token, 'not-a-uuid');
    const unknown = await remove(token, UNKNOWN_ID);

    expect(bad.statusCode).toBe(404);
    expect(bad.body).toBe(unknown.body);
  });
});

describe('authentication', () => {
  it('AC-12: every route refuses a missing or invalid token', async () => {
    const { token } = await account('guard@example.com');
    const created = await create(token, 'Coffee');
    const { id } = created.json() as { id: string };

    const withoutHeader = [
      await app.inject({ method: 'GET', url: '/categories' }),
      await app.inject({ method: 'POST', url: '/categories', payload: { name: 'X' } }),
      await app.inject({ method: 'PATCH', url: `/categories/${id}`, payload: { name: 'X' } }),
      await app.inject({ method: 'DELETE', url: `/categories/${id}` }),
    ];

    for (const response of withoutHeader) {
      expect(response.statusCode).toBe(401);
    }

    const garbage = await app.inject({
      method: 'GET',
      url: '/categories',
      headers: { authorization: 'Bearer not.a.token' },
    });
    expect(garbage.statusCode).toBe(401);

    const expired = app.jwt.sign({ sub: 'someone', email: 'x@example.com' }, { expiresIn: -60 });
    const withExpired = await app.inject({
      method: 'GET',
      url: '/categories',
      headers: auth(expired),
    });
    expect(withExpired.statusCode).toBe(401);
  });

  it('AC-12: an invalid token changes nothing', async () => {
    const { token, userId } = await account('untouched@example.com');
    const created = await create(token, 'Coffee');
    const { id } = created.json() as { id: string };

    await app.inject({ method: 'DELETE', url: `/categories/${id}` });

    expect(await countFor(userId)).toBe(10);
    const { rows } = await database.pool.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM categories WHERE id = $1',
      [id],
    );
    expect(rows[0]!.deleted_at).toBeNull();
  });
});

describe('rate limiting', () => {
  it('AC-13: category routes are not subject to the auth 10/min budget', async () => {
    const { token } = await account('burst@example.com');

    const responses = [];
    for (let i = 0; i < 15; i += 1) {
      responses.push(await list(token));
    }

    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
  });
});
