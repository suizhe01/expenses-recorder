import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Database } from '../db.js';
import {
  dispatchVerificationEmail,
  type EmailTransport,
} from '../email/transport.js';
import {
  createVerificationToken,
  generateVerificationToken,
  isThrottled,
} from '../auth/verification.js';
import {
  DUMMY_PASSWORD_DIGEST,
  hashPassword,
  verifyPassword,
} from '../auth/password.js';
import { seedDefaultCategories } from '../categories/categories.js';
import { fieldErrors } from '../validation.js';
import {
  createSession,
  findSessionByToken,
  findSessionByTokenForUpdate,
  generateRefreshToken,
  isUsable,
  markReplaced,
  revokeAllSessionsForUser,
  revokeSession,
  REFRESH_TOKEN_TTL_MS,
} from '../auth/sessions.js';

/** 15 minutes, per the issue's chosen access-token lifetime. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = '23505';

/** Postgres lock_not_available — raised when lock_timeout expires. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * How long a rotation waits for the session row lock. Far above a normal
 * rotation (single-digit milliseconds) and far below a stuck one.
 */
const LOCK_TIMEOUT_MS = 3_000;

const credentialsSchema = z.object({
  email: z.string().email({ message: 'must be a valid email address' }),
  // AC-4: length only. No composition rules, per current NIST guidance.
  password: z
    .string()
    .min(12, { message: 'must be at least 12 characters' }),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1, { message: 'is required' }),
});

const resendSchema = z.object({
  email: z.string().email(),
});

/**
 * AC-3: one response for every case, so the endpoint reveals nothing about
 * whether an address is registered or already verified.
 */
const VERIFICATION_DISPATCHED = {
  message: 'If that address needs verification, an email is on its way.',
} as const;

/**
 * AC-5 and AC-6: byte-identical whether the account was just created or
 * already existed, so registration cannot be used to discover which addresses
 * are taken.
 */
const REGISTRATION_ACCEPTED = {
  message: 'Check your email to verify your address.',
} as const;

/** AC-8: machine-readable so the app can route to a "resend" screen. */
const EMAIL_NOT_VERIFIED = {
  error: 'Email not verified',
  code: 'email_not_verified',
} as const;

type UserRow = {
  id: string;
  email: string;
  created_at: Date;
};

/**
 * AC-5: both login failure modes must be byte-identical so the endpoint does
 * not reveal whether an address is registered.
 */
const INVALID_CREDENTIALS = { error: 'Invalid email or password' } as const;


/**
 * EXP-11. Documentation only — `tags`, `summary`, `security` and `response`.
 *
 * There is deliberately no `body` or `querystring` anywhere in this codebase.
 * Declaring one switches on Fastify request validation, which answers 400
 * before the handler runs and would undo the deliberate status codes below:
 * login's uniform 401, resend-verification's fixed 202, logout's idempotent
 * 204. Validation stays with the zod schemas above.
 *
 * Error responses are also left undeclared. Their exact bodies are security
 * properties — the login 401 must stay byte-identical across every failure
 * mode — and a response schema silently strips anything it does not mention.
 */
/** The exact 401/403/400 bodies these routes send. Declared so the documented
 *  shapes match reality; the assertions in auth.test.ts prove nothing is
 *  stripped. */
const errorResponse = {
  type: 'object',
  properties: { error: { type: 'string' } },
} as const;

const unverifiedResponse = {
  type: 'object',
  properties: { error: { type: 'string' }, code: { type: 'string' } },
} as const;

const validationResponse = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    fields: { type: 'object', additionalProperties: { type: 'string' } },
  },
} as const;

const sessionResponse = {
  type: 'object',
  properties: {
    user: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        email: { type: 'string', format: 'email' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    accessToken: { type: 'string' },
    refreshToken: { type: 'string' },
    expiresIn: { type: 'number' },
  },
} as const;

const messageResponse = {
  type: 'object',
  properties: { message: { type: 'string' } },
} as const;

export type AuthRouteOptions = {
  config: Config;
  database: Database;
  emailTransport: EmailTransport;
};

export function registerAuthRoutes(
  app: FastifyInstance,
  { config, database, emailTransport }: AuthRouteOptions,
): void {
  function issueTokens(user: UserRow, refreshToken: string) {
    return {
      user: {
        id: user.id,
        email: user.email,
        createdAt: user.created_at.toISOString(),
      },
      accessToken: app.jwt.sign(
        { sub: user.id, email: user.email },
        { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
      ),
      refreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  /**
   * Issues a verification link for `email` and dispatches it, if and only if
   * that address belongs to an account that is still unverified and outside
   * the resend throttle. Silent in every other case.
   *
   * Shared by registration, login's 403, and the resend endpoint so all three
   * obey the same throttle and none of them can be told apart by what they do.
   * Never throws: callers have already committed to their response.
   */
  async function offerVerification(
    request: FastifyRequest,
    email: string,
  ): Promise<void> {
    try {
      const { rows } = await database.pool.query<{
        id: string;
        email_verified: boolean;
      }>(`SELECT id, email_verified FROM users WHERE email = $1`, [email]);

      const user = rows[0];

      if (!user || user.email_verified) {
        return;
      }

      if (await isThrottled(database.pool, user.id)) {
        return;
      }

      const token = generateVerificationToken();

      await database.transaction((client) =>
        createVerificationToken(client, user.id, token),
      );

      const verificationUrl = new URL('/auth/verify', config.PUBLIC_BASE_URL);
      verificationUrl.searchParams.set('token', token);

      // AC-4: dispatch is handed to the event loop, so the caller's response
      // is never waiting on Resend.
      dispatchVerificationEmail(emailTransport, request.log, {
        to: email,
        verificationUrl: verificationUrl.toString(),
      });
    } catch (error) {
      request.log.error({ err: error }, 'failed to offer verification');
    }
  }

  app.post('/auth/register', {
    schema: {
      tags: ['Auth'],
      summary: 'Register an account and send a verification email',
      description:
        'Answers an identical 201 whether the address was free or already taken, '
        + 'so registration cannot be used to discover which addresses exist. An '
        + 'address already in use is left completely untouched.',
      response: { 201: messageResponse, 400: validationResponse },
    },
  }, async (request, reply) => {
    const parsed = credentialsSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'Validation failed', fields: fieldErrors(parsed.error) });
    }

    const { email, password } = parsed.data;

    // AC-11: hashed before the insert is attempted, so the new-account and
    // existing-account paths do the same work. Skipping it for an address that
    // already exists would make that branch measurably faster.
    const passwordHash = await hashPassword(password);

    try {
      // EXP-12 AC-2: the user row and its nine default categories are one
      // transaction, so an account can never exist without them and a failed
      // seed takes the registration down with it rather than leaving a
      // half-made account.
      await database.transaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
          [email, passwordHash],
        );

        await seedDefaultCategories(client, rows[0]!.id);
      });
    } catch (error) {
      // A unique violation means the address is already taken. That is not an
      // error here: AC-6 requires the same response either way, and the
      // existing row is deliberately left exactly as it is — writing the
      // submitted password would let anyone seize an account by re-registering
      // its address. The transaction has already rolled back, so no categories
      // were seeded either (EXP-12 AC-2).
      //
      // email is citext, so the index collides case-insensitively. Relying on
      // it rather than a prior SELECT keeps this free of a race between two
      // simultaneous registrations.
      if ((error as { code?: string }).code !== UNIQUE_VIOLATION) {
        throw error;
      }
    }

    // AC-5 and AC-6: one response for both outcomes. Returning a user object
    // for a new account and something else for an existing one would confirm
    // which addresses are taken — the enumeration this endpoint allowed with
    // its 409. For an existing address nothing is written: the stored password
    // hash is untouched, so re-registering can never take over an account.
    await offerVerification(request, email);

    return reply.code(201).send(REGISTRATION_ACCEPTED);
  });

  app.post('/auth/login', {
    schema: {
      tags: ['Auth'],
      summary: 'Exchange credentials for an access and refresh token',
      description:
        'Returns 401 with one byte-identical body for a wrong password, an unknown '
        + 'address, and a malformed request. Returns 403 with code '
        + '`email_not_verified` only after the password has been proven correct.',
      response: { 200: sessionResponse, 401: errorResponse, 403: unverifiedResponse },
    },
  }, async (request, reply) => {
    const parsed = credentialsSchema.safeParse(request.body);

    // A malformed body is answered with the same 401 as bad credentials: a 400
    // here would let an attacker distinguish "too short" from "wrong", which
    // narrows a guess.
    if (!parsed.success) {
      return reply.code(401).send(INVALID_CREDENTIALS);
    }

    const { email, password } = parsed.data;

    const { rows } = await database.pool.query<
      UserRow & { password_hash: string | null; email_verified: boolean }
    >(
      `SELECT id, email, created_at, password_hash, email_verified
       FROM users WHERE email = $1`,
      [email],
    );

    const user = rows[0];

    // AC-1: every path spends the same time hashing. Returning early for an
    // unknown address would answer ~50ms faster than a wrong password, and
    // that difference alone reveals which addresses are registered — the
    // enumeration the identical response bodies exist to prevent.
    //
    // email_verified is deliberately not consulted here (EXP-6 NG-1).
    const digest = user?.password_hash ?? (await DUMMY_PASSWORD_DIGEST);
    const passwordMatches = await verifyPassword(password, digest);

    if (!user || user.password_hash === null || !passwordMatches) {
      return reply.code(401).send(INVALID_CREDENTIALS);
    }

    // AC-8 and AC-9: verification is checked only AFTER the password has been
    // proven. Checking it first would answer 403 for any registered address
    // regardless of password, which is precisely the enumeration EXP-7
    // removed. Reaching this line means the caller already knows the
    // credentials, so the 403 tells them nothing they did not know.
    if (!user.email_verified) {
      await offerVerification(request, email);
      return reply.code(403).send(EMAIL_NOT_VERIFIED);
    }

    const refreshToken = generateRefreshToken();
    await createSession(database.pool, user.id, refreshToken);

    return reply.code(200).send(issueTokens(user, refreshToken));
  });

  app.post('/auth/refresh', {
    schema: {
      tags: ['Auth'],
      summary: 'Rotate a refresh token',
      description:
        'Both tokens are replaced. Presenting a token that was already rotated is '
        + 'treated as theft and revokes every session for the user. Returns 503 with '
        + 'Retry-After when another rotation of the same session is in flight.',
      response: { 200: sessionResponse, 401: errorResponse, 503: errorResponse },
    },
  }, async (request, reply) => {
    const parsed = refreshSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(401).send({ error: 'Invalid refresh token' });
    }

    const presented = parsed.data.refreshToken;

    // The whole rotation runs in one transaction against a row-locked session.
    // Splitting it across statements let two concurrent refreshes with the same
    // token both pass the checks and both mint a session, after which the
    // second `replaced_by` write orphaned one live token — reachable by its
    // holder but invisible to reuse detection.
    const outcome = await database.transaction(async (client) => {
      // AC-2: bound the wait for the row lock. Without this a rotation whose
      // holder stalls blocks every other refresh of the same session
      // indefinitely. SET LOCAL scopes it to this transaction, so the pooled
      // connection is unaffected once it ends.
      await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);

      const session = await findSessionByTokenForUpdate(client, presented);

      if (!session) {
        return { status: 'invalid' as const };
      }

      // AC-8: replaying a token that was SUPERSEDED BY A REFRESH means it
      // leaked — the legitimate client already moved on, so someone else is
      // holding a copy. There is no way to tell which party is which, so end
      // every session.
      //
      // A session revoked by an explicit logout is deliberately excluded: a
      // client retrying a refresh after logging out is ordinary behaviour, not
      // theft, and treating it as theft would log every other device out too.
      if (session.replaced_by !== null) {
        await revokeAllSessionsForUser(client, session.user_id);
        return { status: 'reused' as const };
      }

      if (session.revoked_at !== null || !isUsable(session)) {
        return { status: 'invalid' as const };
      }

      const { rows } = await client.query<UserRow>(
        `SELECT id, email, created_at FROM users WHERE id = $1`,
        [session.user_id],
      );

      const user = rows[0];

      if (!user) {
        return { status: 'invalid' as const };
      }

      const nextToken = generateRefreshToken();
      const nextSession = await createSession(client, user.id, nextToken);
      await markReplaced(client, session.id, nextSession.id);

      return { status: 'rotated' as const, user, nextToken };
    }).catch((error: unknown) => {
      // AC-2: a lock timeout means another rotation of this same session is
      // genuinely in flight — the token is fine. Answering 401 would push a
      // legitimate client to a login screen, so signal "retry" instead. The
      // transaction rolled back, so nothing was created, revoked, or replaced.
      if ((error as { code?: string }).code === LOCK_NOT_AVAILABLE) {
        return { status: 'locked' as const };
      }
      throw error;
    });

    if (outcome.status === 'locked') {
      return reply
        .code(503)
        .header('Retry-After', '1')
        .send({ error: 'Refresh already in progress, please retry' });
    }

    if (outcome.status !== 'rotated') {
      return reply.code(401).send({ error: 'Invalid refresh token' });
    }

    return reply.code(200).send(issueTokens(outcome.user, outcome.nextToken));
  });

  app.post('/auth/logout', {
    schema: {
      tags: ['Auth'],
      summary: 'Revoke a refresh token',
      description:
        'Idempotent: an unknown, already revoked, or missing token still answers 204, '
        + 'so a client can always reach a signed-out state.',
    },
  }, async (request, reply) => {
    const parsed = refreshSchema.safeParse(request.body);

    // Logout is idempotent: an unknown or already-revoked token still reports
    // success, so a client can always reach a logged-out state.
    if (!parsed.success) {
      return reply.code(204).send();
    }

    const session = await findSessionByToken(database.pool, parsed.data.refreshToken);

    if (session) {
      await revokeSession(database.pool, session.id);
    }

    return reply.code(204).send();
  });

  /**
   * AC-3: the response is identical for an unregistered address, an
   * unverified one, and an already-verified one. Anything else turns this
   * endpoint into the account-enumeration oracle that EXP-7 removed from
   * login — an attacker would simply ask here instead.
   */
  app.post('/auth/resend-verification', {
    schema: {
      tags: ['Auth'],
      summary: 'Send another verification email',
      description:
        'Always answers the same 202, for a registered address, an unregistered one, '
        + 'an already-verified one, and a malformed body alike. Any other shape would '
        + 'make this an account-enumeration oracle. Throttled to one mail a minute.',
      response: { 202: messageResponse },
    },
  }, async (request, reply) => {
    const parsed = resendSchema.safeParse(request.body);

    // Even a malformed body gets the same 202: reporting a validation error
    // for some inputs and not others is itself a signal.
    if (!parsed.success) {
      return reply.code(202).send(VERIFICATION_DISPATCHED);
    }

    await offerVerification(request, parsed.data.email);

    return reply.code(202).send(VERIFICATION_DISPATCHED);
  });

  app.get('/auth/me', {
    schema: {
      tags: ['Auth'],
      summary: 'The signed-in account',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            email: { type: 'string', format: 'email' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        401: errorResponse,
      },
    },
  }, async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const sub = (request.user as { sub?: string }).sub;

    if (!sub) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const { rows } = await database.pool.query<UserRow>(
      `SELECT id, email, created_at FROM users WHERE id = $1`,
      [sub],
    );

    const user = rows[0];

    if (!user) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    return reply.code(200).send({
      id: user.id,
      email: user.email,
      createdAt: user.created_at.toISOString(),
    });
  });
}

export { REFRESH_TOKEN_TTL_MS };
