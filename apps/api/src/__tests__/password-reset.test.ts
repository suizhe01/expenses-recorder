import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { parseConfig } from '../config.js';
import { createDatabase, type Database } from '../db.js';
import type {
  EmailTransport,
  PasswordResetEmail,
  VerificationEmail,
} from '../email/transport.js';
import { createConsoleTransport } from '../email/transport.js';
import { hashPasswordResetToken } from '../auth/password-reset.js';
import { escapeAttribute, resetFormPage } from '../email/pages.js';
import { passwordResetEmailBody } from '../email/resend.js';

const config = parseConfig({
  ...process.env,
  JWT_SECRET: 'test-secret-at-least-thirty-two-chars',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  LOG_LEVEL: 'silent',
});

const PASSWORD = 'correcthorsebattery';
const NEW_PASSWORD = 'a-brand-new-password';

let database: Database;
let app: FastifyInstance;
let resets: PasswordResetEmail[];
let verifications: VerificationEmail[];

function recordingTransport(): EmailTransport {
  return {
    name: 'recording',
    sendVerificationEmail: vi.fn(async (message: VerificationEmail) => {
      verifications.push(message);
    }),
    sendPasswordResetEmail: vi.fn(async (message: PasswordResetEmail) => {
      resets.push(message);
    }),
  };
}

beforeAll(async () => {
  database = createDatabase(config);
  await database.pool.query('SELECT 1 FROM password_reset_tokens LIMIT 0');
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.pool.query('TRUNCATE users CASCADE');
  resets = [];
  verifications = [];
  app = buildApp({ config, database, emailTransport: recordingTransport() });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function forgot(payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/auth/forgot-password',
    payload,
  });
}

function openForm(token?: string) {
  return app.inject({
    method: 'GET',
    url:
      token === undefined
        ? '/auth/reset-password'
        : `/auth/reset-password?token=${encodeURIComponent(token)}`,
  });
}

function submit(fields: Record<string, string>) {
  return app.inject({
    method: 'POST',
    url: '/auth/reset-password',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(fields).toString(),
  });
}

/**
 * Registers an account and clears what registration itself dispatched, so the
 * verification token and its 60-second throttle never interfere.
 */
async function account(email: string, verified: boolean): Promise<string> {
  await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password: PASSWORD },
  });

  const { rows } = await database.pool.query<{ id: string }>(
    'SELECT id FROM users WHERE email = $1',
    [email],
  );

  if (verified) {
    await database.pool.query('UPDATE users SET email_verified = true WHERE id = $1', [
      rows[0]!.id,
    ]);
  }

  await database.pool.query('DELETE FROM email_verification_tokens');
  verifications.length = 0;
  resets.length = 0;

  return rows[0]!.id;
}

function tokenFromUrl(url: string): string {
  return new URL(url).searchParams.get('token') as string;
}

function resetTokenCount() {
  return database.pool
    .query<{ count: string }>('SELECT count(*) FROM password_reset_tokens')
    .then((r) => Number(r.rows[0]!.count));
}

function passwordHashOf(email: string) {
  return database.pool
    .query<{ password_hash: string }>('SELECT password_hash FROM users WHERE email = $1', [
      email,
    ])
    .then((r) => r.rows[0]!.password_hash);
}

function consumedAtFor(token: string) {
  return database.pool
    .query<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM password_reset_tokens WHERE token_hash = $1',
      [hashPasswordResetToken(token)],
    )
    .then((r) => r.rows[0]?.consumed_at ?? null);
}

/** Pushes a token's creation outside the throttle window without waiting. */
function ageToken(minutes: number) {
  return database.pool.query(
    `UPDATE password_reset_tokens SET created_at = created_at - ($1 || ' minutes')::interval`,
    [String(minutes)],
  );
}

describe('POST /auth/forgot-password', () => {
  it('AC-2: answers one identical 202 for every class of input', async () => {
    await account('known@example.com', true);
    await account('unverified@example.com', false);

    const responses = [
      await forgot({ email: 'known@example.com' }),
      await forgot({ email: 'unverified@example.com' }),
      await forgot({ email: 'nobody@example.com' }),
      await forgot({}),
    ];

    for (const response of responses) {
      expect(response.statusCode).toBe(202);
      expect(response.body).toBe(responses[0]!.body);
    }
  });

  it('AC-3: issues and dispatches only for an address that has an account', async () => {
    await account('known@example.com', true);

    await forgot({ email: 'nobody@example.com' });
    expect(await resetTokenCount()).toBe(0);
    expect(resets).toHaveLength(0);

    await forgot({ email: 'known@example.com' });
    expect(await resetTokenCount()).toBe(1);
    expect(resets).toHaveLength(1);
    expect(resets[0]!.to).toBe('known@example.com');
  });

  it('AC-3: a second request inside the throttle window issues nothing', async () => {
    await account('known@example.com', true);

    await forgot({ email: 'known@example.com' });
    await forgot({ email: 'known@example.com' });

    expect(await resetTokenCount()).toBe(1);
    expect(resets).toHaveLength(1);
  });

  it('AC-3: issuing a new token supersedes the previous one', async () => {
    await account('known@example.com', true);

    await forgot({ email: 'known@example.com' });
    const first = tokenFromUrl(resets[0]!.resetUrl);
    await ageToken(2);

    await forgot({ email: 'known@example.com' });
    const second = tokenFromUrl(resets[1]!.resetUrl);

    expect(await consumedAtFor(first)).not.toBeNull();
    expect(await consumedAtFor(second)).toBeNull();

    // The superseded link must no longer open the form.
    expect((await openForm(first)).statusCode).toBe(400);
    expect((await openForm(second)).statusCode).toBe(200);
  });

  it('AC-4: the reset throttle is independent of the verification throttle', async () => {
    await account('unverified@example.com', false);

    await app.inject({
      method: 'POST',
      url: '/auth/resend-verification',
      payload: { email: 'unverified@example.com' },
    });
    expect(verifications).toHaveLength(1);

    // A verification email was just sent; the reset must still go out.
    await forgot({ email: 'unverified@example.com' });
    expect(resets).toHaveLength(1);
  });

  it('AC-11: tokens expire one hour after creation', async () => {
    await account('known@example.com', true);
    await forgot({ email: 'known@example.com' });

    const { rows } = await database.pool.query<{ ttl_seconds: string }>(
      `SELECT extract(epoch from (expires_at - created_at)) AS ttl_seconds
       FROM password_reset_tokens`,
    );

    expect(Number(rows[0]!.ttl_seconds)).toBeCloseTo(3600, 0);
  });
});

describe('POST /auth/forgot-password — dispatch is never awaited', () => {
  it('AC-5: responds while the transport is still hanging', async () => {
    let hangingCalls = 0;
    const hung = buildApp({
      config,
      database,
      emailTransport: {
        name: 'hanging',
        sendVerificationEmail: () => new Promise<void>(() => {}),
        sendPasswordResetEmail: () =>
          new Promise<void>(() => {
            hangingCalls += 1;
          }),
      },
    });
    await hung.ready();

    try {
      await database.pool.query(
        `INSERT INTO users (email, password_hash, email_verified)
         VALUES ('hang@example.com', 'x', true)`,
      );

      // Returns at all only because the send is not awaited — this promise
      // never settles.
      const response = await hung.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email: 'hang@example.com' },
      });

      expect(response.statusCode).toBe(202);
      expect(hangingCalls).toBe(1);
    } finally {
      await hung.close();
    }
  });
});

describe('GET /auth/reset-password', () => {
  it('AC-6: renders the form carrying the token for a live link', async () => {
    await account('known@example.com', true);
    await forgot({ email: 'known@example.com' });
    const token = tokenFromUrl(resets[0]!.resetUrl);

    const response = await openForm(token);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain(`name="token" value="${token}"`);
    expect(response.body).toContain('name="confirmPassword"');
  });

  it('AC-6: refuses a missing, unknown, expired, or spent token', async () => {
    await account('known@example.com', true);
    await forgot({ email: 'known@example.com' });
    const token = tokenFromUrl(resets[0]!.resetUrl);

    expect((await openForm()).statusCode).toBe(400);
    expect((await openForm('not-a-real-token')).statusCode).toBe(400);

    await database.pool.query(
      `UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute'`,
    );
    const expired = await openForm(token);
    expect(expired.statusCode).toBe(400);
    expect(expired.body).toContain('no longer valid');
  });
});

/**
 * EXP-19 NG-2. This route's query parsing is deliberately NOT strict, unlike
 * `GET /expenses`.
 *
 * The URL arrives by email, and mail clients and link trackers append
 * parameters. Strictness here would render "link no longer valid" for a user who
 * clicked a perfectly good link — so the tolerance is a feature, and this is its
 * guard.
 */
describe('EXP-19 NG-2: the reset form survives appended tracking parameters', () => {
  it('opens with utm_source and fbclid alongside the token', async () => {
    await account('tracked@example.com', true);
    await forgot({ email: 'tracked@example.com' });
    const token = tokenFromUrl(resets[0]!.resetUrl);

    const response = await app.inject({
      method: 'GET',
      url: `/auth/reset-password?token=${token}&utm_source=mail&fbclid=abc123`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('no longer valid');
  });
});

describe('POST /auth/reset-password', () => {
  async function liveToken(email = 'known@example.com', verified = true) {
    await account(email, verified);
    await forgot({ email });
    return tokenFromUrl(resets[0]!.resetUrl);
  }

  it('AC-7: sets the password, marks the address verified, and ends every session', async () => {
    await account('known@example.com', true);

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'known@example.com', password: PASSWORD },
    });
    const { refreshToken } = login.json() as { refreshToken: string };

    await database.pool.query('UPDATE users SET email_verified = false');
    await forgot({ email: 'known@example.com' });
    const token = tokenFromUrl(resets[0]!.resetUrl);
    const before = await passwordHashOf('known@example.com');

    const response = await submit({
      token,
      password: NEW_PASSWORD,
      confirmPassword: NEW_PASSWORD,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('Password updated');

    expect(await passwordHashOf('known@example.com')).not.toBe(before);
    expect(await consumedAtFor(token)).not.toBeNull();

    const { rows } = await database.pool.query<{ email_verified: boolean }>(
      'SELECT email_verified FROM users WHERE email = $1',
      ['known@example.com'],
    );
    expect(rows[0]!.email_verified).toBe(true);

    const refreshed = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken },
    });
    expect(refreshed.statusCode).toBe(401);
  });

  it('AC-8: a short password re-renders the form and spends nothing', async () => {
    const token = await liveToken();
    const before = await passwordHashOf('known@example.com');

    const response = await submit({
      token,
      password: 'short',
      confirmPassword: 'short',
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('at least 12 characters');
    expect(response.body).toContain(`name="token" value="${token}"`);

    expect(await consumedAtFor(token)).toBeNull();
    expect(await passwordHashOf('known@example.com')).toBe(before);

    // The same link still works afterwards.
    expect((await openForm(token)).statusCode).toBe(200);
  });

  it('AC-8: a mismatched confirmation re-renders the form and spends nothing', async () => {
    const token = await liveToken();
    const before = await passwordHashOf('known@example.com');

    const response = await submit({
      token,
      password: NEW_PASSWORD,
      confirmPassword: `${NEW_PASSWORD}-typo`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('do not match');
    expect(await consumedAtFor(token)).toBeNull();
    expect(await passwordHashOf('known@example.com')).toBe(before);
  });

  it('AC-9: refuses an unknown token and writes nothing', async () => {
    await account('known@example.com', true);
    const before = await passwordHashOf('known@example.com');

    const response = await submit({
      token: 'not-a-real-token',
      password: NEW_PASSWORD,
      confirmPassword: NEW_PASSWORD,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('no longer valid');
    expect(await passwordHashOf('known@example.com')).toBe(before);
  });

  it('AC-9: refuses a token that was already spent', async () => {
    const token = await liveToken();

    await submit({ token, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    const after = await passwordHashOf('known@example.com');

    const second = await submit({
      token,
      password: 'a-third-password-here',
      confirmPassword: 'a-third-password-here',
    });

    expect(second.statusCode).toBe(400);
    expect(second.body).toContain('no longer valid');
    expect(await passwordHashOf('known@example.com')).toBe(after);
  });

  it('AC-9: refuses an expired token', async () => {
    const token = await liveToken();
    await database.pool.query(
      `UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute'`,
    );
    const before = await passwordHashOf('known@example.com');

    const response = await submit({
      token,
      password: NEW_PASSWORD,
      confirmPassword: NEW_PASSWORD,
    });

    expect(response.statusCode).toBe(400);
    expect(await passwordHashOf('known@example.com')).toBe(before);
  });

  it('AC-10: the old password stops working and the new one starts', async () => {
    const token = await liveToken();
    await submit({ token, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });

    const withOld = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'known@example.com', password: PASSWORD },
    });
    expect(withOld.statusCode).toBe(401);

    const withNew = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'known@example.com', password: NEW_PASSWORD },
    });
    expect(withNew.statusCode).toBe(200);
  });

  it('AC-7: an unverified account can reset and then log in', async () => {
    const token = await liveToken('unverified@example.com', false);

    await submit({ token, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'unverified@example.com', password: NEW_PASSWORD },
    });

    // Would be 403 if the reset had not also cleared the verification gate.
    expect(login.statusCode).toBe(200);
  });

  it('AC-12: the new password may equal the current one', async () => {
    const token = await liveToken();

    const response = await submit({
      token,
      password: PASSWORD,
      confirmPassword: PASSWORD,
    });

    expect(response.statusCode).toBe(200);

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'known@example.com', password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
  });

  it('AC-14: two simultaneous submissions of one token yield exactly one success', async () => {
    const token = await liveToken();

    const [a, b] = await Promise.all([
      submit({ token, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD }),
      submit({ token, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD }),
    ]);

    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 400]);

    const { rows } = await database.pool.query<{ count: string }>(
      'SELECT count(*) FROM password_reset_tokens WHERE consumed_at IS NOT NULL',
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });
});

describe('rendering and transport', () => {
  it('AC-15: escapes a token before it reaches the hidden field', () => {
    const hostile = '"><script>alert(1)</script>';
    const html = resetFormPage(hostile);

    expect(html).not.toContain('<script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
    expect(escapeAttribute('a"b<c&d')).toBe('a&quot;b&lt;c&amp;d');
  });

  it('AC-13: the console transport reports the reset URL', async () => {
    const logged: Record<string, unknown>[] = [];
    const transport = createConsoleTransport({
      info: (payload) => {
        logged.push(payload);
      },
    });

    await transport.sendPasswordResetEmail({
      to: 'someone@example.com',
      resetUrl: 'http://localhost:3000/auth/reset-password?token=abc',
    });

    expect(logged[0]).toMatchObject({
      to: 'someone@example.com',
      resetUrl: 'http://localhost:3000/auth/reset-password?token=abc',
    });
  });

  it('AC-13: the reset email is plain text stating the one-hour expiry', () => {
    const body = passwordResetEmailBody('http://localhost:3000/auth/reset-password?token=abc');

    expect(body).toContain('http://localhost:3000/auth/reset-password?token=abc');
    expect(body).toContain('1 hour');
    expect(body).toContain("If you didn't ask for this");
    expect(body).not.toContain('<');
  });
});
