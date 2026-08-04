import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
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

function fieldErrors(error: z.ZodError): Record<string, string> {
  return Object.fromEntries(
    error.issues.map((issue) => [issue.path.join('.'), issue.message]),
  );
}

export type AuthRouteOptions = {
  database: Database;
};

export function registerAuthRoutes(
  app: FastifyInstance,
  { database }: AuthRouteOptions,
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

  app.post('/auth/register', async (request, reply) => {
    const parsed = credentialsSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'Validation failed', fields: fieldErrors(parsed.error) });
    }

    const { email, password } = parsed.data;
    const passwordHash = await hashPassword(password);

    let user: UserRow;

    try {
      const { rows } = await database.pool.query<UserRow>(
        `INSERT INTO users (email, password_hash)
         VALUES ($1, $2)
         RETURNING id, email, created_at`,
        [email, passwordHash],
      );
      user = rows[0] as UserRow;
    } catch (error) {
      // AC-3: email is citext, so the unique index already collides
      // case-insensitively. Relying on it rather than a prior SELECT keeps the
      // check free of a race between two simultaneous registrations.
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        return reply
          .code(409)
          .send({ error: 'That email address is already registered' });
      }
      throw error;
    }

    const refreshToken = generateRefreshToken();
    await createSession(database.pool, user.id, refreshToken);

    return reply.code(201).send(issueTokens(user, refreshToken));
  });

  app.post('/auth/login', async (request, reply) => {
    const parsed = credentialsSchema.safeParse(request.body);

    // A malformed body is answered with the same 401 as bad credentials: a 400
    // here would let an attacker distinguish "too short" from "wrong", which
    // narrows a guess.
    if (!parsed.success) {
      return reply.code(401).send(INVALID_CREDENTIALS);
    }

    const { email, password } = parsed.data;

    const { rows } = await database.pool.query<UserRow & { password_hash: string | null }>(
      `SELECT id, email, created_at, password_hash FROM users WHERE email = $1`,
      [email],
    );

    const user = rows[0];

    // NG-1: email_verified is deliberately not consulted here.
    if (!user || user.password_hash === null) {
      return reply.code(401).send(INVALID_CREDENTIALS);
    }

    if (!(await verifyPassword(password, user.password_hash))) {
      return reply.code(401).send(INVALID_CREDENTIALS);
    }

    const refreshToken = generateRefreshToken();
    await createSession(database.pool, user.id, refreshToken);

    return reply.code(200).send(issueTokens(user, refreshToken));
  });

  app.post('/auth/refresh', async (request, reply) => {
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
    });

    if (outcome.status !== 'rotated') {
      return reply.code(401).send({ error: 'Invalid refresh token' });
    }

    return reply.code(200).send(issueTokens(outcome.user, outcome.nextToken));
  });

  app.post('/auth/logout', async (request, reply) => {
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

  app.get('/auth/me', async (request, reply) => {
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
