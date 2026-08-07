import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { parseConfig } from '../config.js';
import { createDatabase, type Database } from '../db.js';
import type { EmailTransport, VerificationEmail } from '../email/transport.js';
import {
  hashVerificationToken,
  RESEND_THROTTLE_MS,
} from '../auth/verification.js';

const config = parseConfig({
  ...process.env,
  JWT_SECRET: 'test-secret-at-least-thirty-two-chars',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  LOG_LEVEL: 'silent',
});

const PASSWORD = 'correcthorsebattery';

let database: Database;
let app: FastifyInstance;
let sent: VerificationEmail[];

/** Captures what would have been emailed, so tests need not read log output. */
function recordingTransport(): EmailTransport {
  return {
    name: 'recording',
    sendVerificationEmail: vi.fn(async (message: VerificationEmail) => {
      sent.push(message);
    }),
    // EXP-10 added this to the interface. These tests never reset a password,
    // so it exists only to satisfy the type.
    sendPasswordResetEmail: vi.fn(async () => {}),
  };
}

beforeAll(async () => {
  database = createDatabase(config);
  await database.pool.query('SELECT 1 FROM email_verification_tokens LIMIT 0');
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.pool.query('TRUNCATE users CASCADE');
  sent = [];
  app = buildApp({ config, database, emailTransport: recordingTransport() });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function register(email: string) {
  return app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password: PASSWORD },
  });
}

function resend(email: string) {
  return app.inject({
    method: 'POST',
    url: '/auth/resend-verification',
    payload: { email },
  });
}

function verify(token?: string) {
  return app.inject({
    method: 'GET',
    url: token === undefined ? '/auth/verify' : `/auth/verify?token=${token}`,
  });
}

/**
 * New accounts are unverified by default since EXP-9, so registering suffices.
 *
 * Registration also issues and dispatches a token, which would otherwise trip
 * the 60-second throttle in every test that then calls resend. Both are
 * cleared so each test starts from a clean slate.
 */
async function unverifiedUser(email: string): Promise<string> {
  await register(email);
  const { rows } = await database.pool.query<{ id: string }>(
    'SELECT id FROM users WHERE email = $1',
    [email],
  );
  await database.pool.query('DELETE FROM email_verification_tokens');
  sent.length = 0;
  return rows[0]!.id;
}

/** An account that has completed verification. */
async function verifiedUser(email: string): Promise<string> {
  const id = await unverifiedUser(email);
  await database.pool.query('UPDATE users SET email_verified = true WHERE id = $1', [id]);
  await database.pool.query('DELETE FROM email_verification_tokens WHERE user_id = $1', [id]);
  return id;
}

function tokenFromUrl(url: string): string {
  return new URL(url).searchParams.get('token') as string;
}

async function tokenCount(): Promise<number> {
  const { rows } = await database.pool.query<{ count: string }>(
    'SELECT count(*) FROM email_verification_tokens',
  );
  return Number(rows[0]?.count);
}

describe('POST /auth/resend-verification', () => {
  // AC-3
  it('returns an identical 202 for unregistered, unverified, and verified addresses', async () => {
    await unverifiedUser('pending@x.com');
    await verifiedUser('done@x.com');

    const unregistered = await resend('nobody@x.com');
    const pending = await resend('pending@x.com');
    const verified = await resend('done@x.com');

    for (const response of [unregistered, pending, verified]) {
      expect(response.statusCode).toBe(202);
    }

    expect(unregistered.body).toBe(pending.body);
    expect(pending.body).toBe(verified.body);
  });

  // AC-3: a token exists only for the case that warrants one.
  it('creates a token and dispatches only for a registered unverified address', async () => {
    await unverifiedUser('pending@x.com');
    await verifiedUser('done@x.com');

    await resend('nobody@x.com');
    await resend('done@x.com');
    expect(await tokenCount()).toBe(0);
    expect(sent).toHaveLength(0);

    await resend('pending@x.com');
    expect(await tokenCount()).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('pending@x.com');
    expect(sent[0]?.verificationUrl).toContain('http://localhost:3000/auth/verify?token=');
  });

  it('returns the same 202 for a malformed body', async () => {
    const good = await resend('nobody@x.com');
    const bad = await app.inject({
      method: 'POST',
      url: '/auth/resend-verification',
      payload: { email: 'not-an-email' },
    });

    expect(bad.statusCode).toBe(202);
    expect(bad.body).toBe(good.body);
    expect(await tokenCount()).toBe(0);
  });

  // AC-4
  it('does not issue a second token within the throttle window', async () => {
    await unverifiedUser('pending@x.com');

    await resend('pending@x.com');
    const second = await resend('pending@x.com');

    expect(second.statusCode).toBe(202);
    expect(await tokenCount()).toBe(1);
    expect(sent).toHaveLength(1);
  });

  // AC-4: and issues again once the window has passed.
  it('issues again after the throttle window', async () => {
    const userId = await unverifiedUser('pending@x.com');
    await resend('pending@x.com');

    // Age the existing token past the window rather than waiting a minute.
    await database.pool.query(
      `UPDATE email_verification_tokens
       SET created_at = now() - ($2::int * interval '1 millisecond')
       WHERE user_id = $1`,
      [userId, RESEND_THROTTLE_MS + 5_000],
    );

    await resend('pending@x.com');

    expect(await tokenCount()).toBe(2);
    expect(sent).toHaveLength(2);
  });

  // AC-5
  it('supersedes the previous token so only the newest link works', async () => {
    const userId = await unverifiedUser('pending@x.com');

    await resend('pending@x.com');
    const firstUrl = sent[0]?.verificationUrl as string;

    await database.pool.query(
      `UPDATE email_verification_tokens
       SET created_at = now() - ($2::int * interval '1 millisecond')
       WHERE user_id = $1`,
      [userId, RESEND_THROTTLE_MS + 5_000],
    );

    await resend('pending@x.com');
    const secondUrl = sent[1]?.verificationUrl as string;
    expect(secondUrl).not.toBe(firstUrl);

    // The superseded link is spent, so it reports already-verified, and the
    // account is NOT verified by it.
    const stale = await verify(tokenFromUrl(firstUrl));
    expect(stale.statusCode).toBe(200);
    expect(stale.body).toContain('Already verified');

    const { rows } = await database.pool.query<{ email_verified: boolean }>(
      'SELECT email_verified FROM users WHERE id = $1',
      [userId],
    );
    expect(rows[0]?.email_verified).toBe(false);

    expect((await verify(tokenFromUrl(secondUrl))).statusCode).toBe(200);
  });

  // AC-11
  it('stores only a hash of the token, never the plaintext', async () => {
    await unverifiedUser('pending@x.com');
    await resend('pending@x.com');

    const token = tokenFromUrl(sent[0]?.verificationUrl as string);
    // 32 random bytes, base64url encoded.
    expect(token.length).toBeGreaterThanOrEqual(43);

    const { rows } = await database.pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM email_verification_tokens',
    );

    expect(rows[0]?.token_hash).not.toBe(token);
    expect(rows[0]?.token_hash).toBe(hashVerificationToken(token));
  });
});

/**
 * AC-4. Asserted structurally rather than with a stopwatch: a transport whose
 * send never settles. If a response still arrives, dispatch provably is not on
 * the request path — which is the property that stops a slow Resend call
 * turning response time into an account-enumeration oracle.
 */
describe('email dispatch never blocks a response', () => {
  let hung: FastifyInstance;
  let hangingCalls: number;

  beforeEach(async () => {
    hangingCalls = 0;
    hung = buildApp({
      config,
      database,
      emailTransport: {
        name: 'hanging',
        sendVerificationEmail: () =>
          new Promise<void>(() => {
            hangingCalls += 1;
          }),
        sendPasswordResetEmail: () => new Promise<void>(() => {}),
      },
    });
    await hung.ready();
  });

  afterEach(async () => {
    await hung.close();
  });

  it('responds to register, login, and resend while the transport hangs', async () => {
    const registered = await hung.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'hang@x.com', password: PASSWORD },
    });
    expect(registered.statusCode).toBe(201);

    const loggedIn = await hung.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'hang@x.com', password: PASSWORD },
    });
    expect(loggedIn.statusCode).toBe(403);

    await database.pool.query('DELETE FROM email_verification_tokens');

    const resent = await hung.inject({
      method: 'POST',
      url: '/auth/resend-verification',
      payload: { email: 'hang@x.com' },
    });
    expect(resent.statusCode).toBe(202);

    // The sends were started and are still pending — every response above
    // arrived without waiting for any of them.
    expect(hangingCalls).toBeGreaterThan(0);
  }, 10_000);

  it('keeps responses unchanged when the transport rejects', async () => {
    const rejecting = buildApp({
      config,
      database,
      emailTransport: {
        name: 'rejecting',
        sendVerificationEmail: () => Promise.reject(new Error('provider down')),
        sendPasswordResetEmail: () => Promise.reject(new Error('provider down')),
      },
    });
    await rejecting.ready();

    try {
      const response = await rejecting.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'boom@x.com', password: PASSWORD },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        message: 'Check your email to verify your address.',
      });

      // The account still exists — a provider failure must not lose a signup.
      const users = await database.pool.query('SELECT id FROM users');
      expect(users.rowCount).toBe(1);
    } finally {
      await rejecting.close();
    }
  });
});

describe('GET /auth/verify', () => {
  async function issuedToken(email = 'pending@x.com'): Promise<{ userId: string; token: string }> {
    const userId = await unverifiedUser(email);
    await resend(email);
    return { userId, token: tokenFromUrl(sent[0]?.verificationUrl as string) };
  }

  // AC-6
  it('verifies the account and returns an HTML success page', async () => {
    const { userId, token } = await issuedToken();

    const response = await verify(token);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('Email verified');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.body).not.toContain(token);

    const { rows } = await database.pool.query<{
      email_verified: boolean;
      consumed_at: Date | null;
    }>(
      `SELECT u.email_verified, t.consumed_at
       FROM users u JOIN email_verification_tokens t ON t.user_id = u.id
       WHERE u.id = $1`,
      [userId],
    );

    expect(rows[0]?.email_verified).toBe(true);
    expect(rows[0]?.consumed_at).not.toBeNull();
  });

  // AC-7
  it('shows the already-verified page when the same link is opened twice', async () => {
    const { token } = await issuedToken();

    await verify(token);
    const second = await verify(token);

    expect(second.statusCode).toBe(200);
    expect(second.body).toContain('Already verified');
  });

  // AC-8
  it('returns 400 HTML for missing, unknown, and malformed tokens', async () => {
    for (const response of [await verify(), await verify(''), await verify('garbage')]) {
      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('no longer valid');
    }
  });

  // AC-8
  it('returns 400 HTML for an expired token and leaves the account unverified', async () => {
    const { userId, token } = await issuedToken();

    await database.pool.query(
      `UPDATE email_verification_tokens SET expires_at = now() - interval '1 hour'
       WHERE user_id = $1`,
      [userId],
    );

    const response = await verify(token);

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('no longer valid');

    const { rows } = await database.pool.query<{ email_verified: boolean }>(
      'SELECT email_verified FROM users WHERE id = $1',
      [userId],
    );
    expect(rows[0]?.email_verified).toBe(false);
  });

  // AC-10
  it('serves fully self-contained pages with no external references', async () => {
    const { token } = await issuedToken();

    const pages = [
      (await verify(token)).body,
      (await verify(token)).body,
      (await verify('garbage')).body,
    ];

    for (const html of pages) {
      expect(html).not.toMatch(/<link\b/i);
      expect(html).not.toMatch(/<script\b/i);
      expect(html).not.toMatch(/<img\b/i);
      expect(html).not.toMatch(/https?:\/\/(?!localhost)/i);
      expect(html).toContain('<meta name="viewport"');
    }
  });
});
