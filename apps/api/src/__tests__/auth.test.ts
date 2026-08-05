import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { parseConfig } from '../config.js';
import { createDatabase, type Database } from '../db.js';
import { hashRefreshToken } from '../auth/sessions.js';
import * as password from '../auth/password.js';

/**
 * These tests run against a real Postgres — the schema, the citext uniqueness,
 * and the session rotation are exactly what is under test, so mocking them
 * would test nothing. CI applies migrations before invoking vitest; locally,
 * run `docker compose up -d && npm run migrate` first.
 */
const config = parseConfig({
  ...process.env,
  JWT_SECRET: 'test-secret-at-least-thirty-two-chars',
  LOG_LEVEL: 'silent',
});

const PASSWORD = 'correcthorsebattery';

let database: Database;
let app: FastifyInstance;

beforeAll(async () => {
  database = createDatabase(config);
  // Fail loudly and immediately if the database is not migrated, rather than
  // letting every assertion fail with a confusing relation-does-not-exist.
  await database.pool.query('SELECT 1 FROM sessions LIMIT 0');
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  // Cascade clears sessions via the foreign key.
  await database.pool.query('TRUNCATE users CASCADE');
  app = buildApp({ config, database });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function register(email: string, password: string = PASSWORD) {
  return app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password },
  });
}

function login(email: string, password: string = PASSWORD) {
  return app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password },
  });
}

function refresh(refreshToken: string) {
  return app.inject({
    method: 'POST',
    url: '/auth/refresh',
    payload: { refreshToken },
  });
}

describe('POST /auth/register', () => {
  // AC-2
  it('creates a user and a session, returning both tokens', async () => {
    const response = await register('a@b.com');
    expect(response.statusCode).toBe(201);

    const body = response.json();
    expect(body.user.email).toBe('a@b.com');
    expect(body.user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.user).not.toHaveProperty('password_hash');
    expect(body.accessToken).toBeTypeOf('string');
    expect(body.refreshToken).toBeTypeOf('string');
    expect(body.expiresIn).toBe(900);

    const users = await database.pool.query('SELECT id FROM users');
    const sessions = await database.pool.query('SELECT id FROM sessions');
    expect(users.rowCount).toBe(1);
    expect(sessions.rowCount).toBe(1);
  });

  // AC-3
  it('rejects a duplicate email case-insensitively without creating rows', async () => {
    await register('foo@x.com');
    const response = await register('Foo@x.com');

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/already registered/i);

    const users = await database.pool.query('SELECT id FROM users');
    expect(users.rowCount).toBe(1);
  });

  // AC-4
  it('rejects a password shorter than 12 characters, naming the field', async () => {
    const response = await register('short@x.com', 'short');

    expect(response.statusCode).toBe(400);
    expect(response.json().fields).toHaveProperty('password');

    const users = await database.pool.query('SELECT id FROM users');
    expect(users.rowCount).toBe(0);
  });

  it('rejects a malformed email, naming the field', async () => {
    const response = await register('not-an-email');

    expect(response.statusCode).toBe(400);
    expect(response.json().fields).toHaveProperty('email');
  });

  // AC-4: no composition rules.
  it('accepts a 12-character all-lowercase password', async () => {
    const response = await register('lower@x.com', 'abcdefghijkl');
    expect(response.statusCode).toBe(201);
  });

  // AC-6
  it('stores a salted scrypt digest, never the plaintext', async () => {
    await register('one@x.com');
    await register('two@x.com');

    const { rows } = await database.pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users ORDER BY email',
    );

    for (const row of rows) {
      expect(row.password_hash).toMatch(/^scrypt\$/);
      expect(row.password_hash).not.toContain(PASSWORD);
    }

    // Same password, different salts.
    expect(rows[0]?.password_hash).not.toBe(rows[1]?.password_hash);
  });
});

describe('POST /auth/login', () => {
  // AC-5
  it('returns tokens for correct credentials', async () => {
    await register('a@b.com');
    const response = await login('a@b.com');

    expect(response.statusCode).toBe(200);
    expect(response.json().refreshToken).toBeTypeOf('string');
  });

  // AC-5: both failure modes must be indistinguishable.
  it('returns an identical 401 for a wrong password and an unknown email', async () => {
    await register('a@b.com');

    const wrongPassword = await login('a@b.com', 'wrongpasswordhere');
    const unknownEmail = await login('nobody@x.com');

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.body).toBe(unknownEmail.body);
    expect(wrongPassword.json().error).toBe('Invalid email or password');
  });

  it('is case-insensitive on the email', async () => {
    await register('foo@x.com');
    expect((await login('FOO@x.com')).statusCode).toBe(200);
  });

  // AC-1: the bodies were already identical, but an unknown address used to
  // return ~50ms sooner because it skipped hashing entirely. That difference
  // alone reveals which addresses are registered. Asserting the scrypt call
  // count is deterministic; asserting wall-clock timing is not.
  it('performs exactly one scrypt verification on every failing path', async () => {
    await register('exists@x.com');
    await database.pool.query(
      `INSERT INTO users (email, password_hash) VALUES ($1, NULL)`,
      ['nohash@x.com'],
    );

    const spy = vi.spyOn(password, 'verifyPassword');

    const cases = ['exists@x.com', 'nobody@x.com', 'nohash@x.com'];
    const bodies: string[] = [];

    for (const email of cases) {
      spy.mockClear();
      const response = await login(email, 'definitelywrongpassword');

      expect(response.statusCode).toBe(401);
      expect(spy, `expected one hash for ${email}`).toHaveBeenCalledTimes(1);
      bodies.push(response.body);
    }

    // AC-5 of EXP-6 still holds: the responses remain byte-identical.
    expect(new Set(bodies).size).toBe(1);

    spy.mockRestore();
  });
});

describe('POST /auth/refresh', () => {
  // AC-7
  it('rotates both tokens and invalidates the old refresh token', async () => {
    const registered = (await register('a@b.com')).json();

    const rotated = await refresh(registered.refreshToken);
    expect(rotated.statusCode).toBe(200);

    const body = rotated.json();
    expect(body.refreshToken).not.toBe(registered.refreshToken);
    expect(body.accessToken).toBeTypeOf('string');

    const { rows } = await database.pool.query<{
      revoked_at: Date | null;
      replaced_by: string | null;
    }>('SELECT revoked_at, replaced_by FROM sessions WHERE replaced_by IS NOT NULL');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.revoked_at).not.toBeNull();
    expect(rows[0]?.replaced_by).not.toBeNull();
  });

  it('rejects an unknown refresh token', async () => {
    expect((await refresh('never-issued')).statusCode).toBe(401);
  });

  // Regression, mechanism-level: rotation used to be three separate statements
  // outside a transaction, so two concurrent refreshes with the same token
  // could both pass the checks and both mint a session, leaving one live
  // refresh token that reuse detection could never reach.
  //
  // Driving that race through app.inject() is not reliable — the requests do
  // not interleave predictably. This asserts the mechanism directly: a second
  // transaction attempting to lock the same session row must block until the
  // first commits.
  it('serialises concurrent rotations by locking the session row', async () => {
    const registered = (await register('a@b.com')).json();
    const tokenHash = hashRefreshToken(registered.refreshToken);

    const holder = await database.pool.connect();
    const contender = await database.pool.connect();

    try {
      await holder.query('BEGIN');
      const locked = await holder.query(
        'SELECT id FROM sessions WHERE token_hash = $1 FOR UPDATE',
        [tokenHash],
      );
      expect(locked.rowCount).toBe(1);

      // The contender must not be able to take the same row. If it returns
      // instead of timing out, rotations are not serialised.
      await contender.query('BEGIN');
      await contender.query('SET LOCAL statement_timeout = 500');

      await expect(
        contender.query('SELECT id FROM sessions WHERE token_hash = $1 FOR UPDATE', [
          tokenHash,
        ]),
      ).rejects.toThrow(/statement timeout/i);
    } finally {
      await contender.query('ROLLBACK').catch(() => undefined);
      await holder.query('ROLLBACK').catch(() => undefined);
      contender.release();
      holder.release();
    }
  });

  // AC-2: a lock wait means another rotation of this same session is in
  // flight, not that the token is bad. Before this the request waited forever.
  it('returns 503 with Retry-After when the session row is already locked', async () => {
    const registered = (await register('a@b.com')).json();
    const tokenHash = hashRefreshToken(registered.refreshToken);

    const holder = await database.pool.connect();

    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM sessions WHERE token_hash = $1 FOR UPDATE', [
        tokenHash,
      ]);

      const before = await database.pool.query('SELECT count(*) FROM sessions');

      const startedAt = Date.now();
      const response = await refresh(registered.refreshToken);
      const elapsed = Date.now() - startedAt;

      expect(response.statusCode).toBe(503);
      expect(response.headers['retry-after']).toBe('1');
      // Distinct from the invalid-token 401 so a client can tell them apart.
      expect(response.json().error).not.toBe('Invalid refresh token');

      // Bounded by lock_timeout rather than hanging, with headroom for CI.
      expect(elapsed).toBeLessThan(10_000);

      // Nothing was created, revoked, or replaced.
      const after = await database.pool.query('SELECT count(*) FROM sessions');
      expect(after.rows[0]).toEqual(before.rows[0]);

      const { rows } = await database.pool.query<{ count: string }>(
        'SELECT count(*) FROM sessions WHERE revoked_at IS NOT NULL',
      );
      expect(rows[0]?.count).toBe('0');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  }, 20_000);

  it('leaves every rotated session reachable from its predecessor', async () => {
    const registered = (await register('a@b.com')).json();

    const results = await Promise.all([
      refresh(registered.refreshToken),
      refresh(registered.refreshToken),
    ]);

    const succeeded = results.filter((r) => r.statusCode === 200);
    expect(succeeded).toHaveLength(1);

    // One original + exactly one replacement. A third row would mean the race
    // minted an orphan.
    const { rows } = await database.pool.query<{ count: string }>(
      'SELECT count(*) FROM sessions',
    );
    expect(rows[0]?.count).toBe('2');

    // Every session created by the rotation is reachable from its predecessor.
    const orphans = await database.pool.query(
      `SELECT id FROM sessions s
       WHERE s.id <> $1
         AND NOT EXISTS (SELECT 1 FROM sessions p WHERE p.replaced_by = s.id)`,
      [
        (
          await database.pool.query<{ id: string }>(
            'SELECT id FROM sessions ORDER BY created_at ASC LIMIT 1',
          )
        ).rows[0]?.id,
      ],
    );
    expect(orphans.rowCount).toBe(0);
  });

  // AC-8
  it('revokes every session for the user when a rotated token is reused', async () => {
    const first = (await register('a@b.com')).json();
    const secondDevice = (await login('a@b.com')).json();

    const rotated = (await refresh(first.refreshToken)).json();

    // Replay the already-rotated token: this is the theft signal.
    const replay = await refresh(first.refreshToken);
    expect(replay.statusCode).toBe(401);

    // Both the rotated token and the untouched second device are now dead.
    expect((await refresh(rotated.refreshToken)).statusCode).toBe(401);
    expect((await refresh(secondDevice.refreshToken)).statusCode).toBe(401);

    const { rows } = await database.pool.query<{ count: string }>(
      'SELECT count(*) FROM sessions WHERE revoked_at IS NULL',
    );
    expect(rows[0]?.count).toBe('0');
  });
});

describe('POST /auth/logout', () => {
  // AC-9
  it('revokes only the presented session', async () => {
    const phone = (await register('a@b.com')).json();
    const tablet = (await login('a@b.com')).json();

    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      payload: { refreshToken: phone.refreshToken },
    });

    expect(response.statusCode).toBe(204);
    expect((await refresh(phone.refreshToken)).statusCode).toBe(401);
    expect((await refresh(tablet.refreshToken)).statusCode).toBe(200);
  });

  // AC-8 vs AC-9: a client retrying a refresh after logout is ordinary, not
  // theft. Replaying a logged-out token must NOT cascade to other devices.
  it('does not treat a replayed logged-out token as theft', async () => {
    const phone = (await register('a@b.com')).json();
    const tablet = (await login('a@b.com')).json();

    await app.inject({
      method: 'POST',
      url: '/auth/logout',
      payload: { refreshToken: phone.refreshToken },
    });

    // Replay the dead token twice, as a retrying client would.
    expect((await refresh(phone.refreshToken)).statusCode).toBe(401);
    expect((await refresh(phone.refreshToken)).statusCode).toBe(401);

    // The tablet is untouched.
    expect((await refresh(tablet.refreshToken)).statusCode).toBe(200);
  });

  it('is idempotent for an unknown token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      payload: { refreshToken: 'never-issued' },
    });

    expect(response.statusCode).toBe(204);
  });
});

describe('GET /auth/me', () => {
  function me(authorization?: string) {
    return app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: authorization ? { authorization } : {},
    });
  }

  // AC-10
  it('returns the caller for a valid access token', async () => {
    const registered = (await register('a@b.com')).json();
    const response = await me(`Bearer ${registered.accessToken}`);

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.email).toBe('a@b.com');
    expect(body.id).toBe(registered.user.id);
    expect(body).not.toHaveProperty('password_hash');
  });

  it('rejects missing, malformed, and wrongly-signed tokens', async () => {
    expect((await me()).statusCode).toBe(401);
    expect((await me('Bearer garbage')).statusCode).toBe(401);
    expect((await me('NotBearer x')).statusCode).toBe(401);

    // Signed with a different secret.
    const foreign = buildApp({
      config: { ...config, JWT_SECRET: 'a-completely-different-secret-value' },
      database,
    });
    await foreign.ready();
    const foreignToken = foreign.jwt.sign({ sub: '00000000-0000-0000-0000-000000000000' });
    await foreign.close();

    expect((await me(`Bearer ${foreignToken}`)).statusCode).toBe(401);
  });

  it('rejects an expired token', async () => {
    await register('a@b.com');
    const expired = app.jwt.sign({ sub: '00000000-0000-0000-0000-000000000000' }, { expiresIn: -1 });

    expect((await me(`Bearer ${expired}`)).statusCode).toBe(401);
  });
});

describe('rate limiting', () => {
  // AC-11
  it('returns 429 with Retry-After after 10 requests a minute', async () => {
    const responses = [];
    for (let i = 0; i < 12; i += 1) {
      responses.push(await login('nobody@x.com'));
    }

    const limited = responses.filter((r) => r.statusCode === 429);
    expect(limited.length).toBeGreaterThan(0);
    expect(limited[0]?.headers['retry-after']).toBeDefined();
  });

  // AC-11: /health must stay unlimited.
  it('does not rate limit /health', async () => {
    for (let i = 0; i < 15; i += 1) {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
    }
  });
});
