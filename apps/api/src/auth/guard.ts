import type { FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The `sub` of a verified access token. Present only on routes that ran
     * `requireAuth`, which is why the accessor below exists rather than
     * reading this field directly.
     */
    authenticatedUserId?: string;
  }
}

/**
 * EXP-12 / AC-12. One 401 body for every way authentication can fail —
 * missing header, malformed token, bad signature, expired — so the endpoint
 * says nothing about which.
 */
const UNAUTHORIZED = { error: 'Unauthorized' } as const;

/**
 * `preHandler` for routes that require a signed-in user.
 *
 * Deliberately does not confirm the user still exists in the database. Every
 * query behind this guard is scoped by `user_id`, so a token belonging to a
 * deleted account simply matches nothing — and skipping the round-trip keeps
 * an authenticated read to a single query.
 *
 * `/auth/me` keeps its own inline verification (EXP-12 NG-4): it does need the
 * user row, because returning it is the entire point of that endpoint.
 */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    return reply.code(401).send(UNAUTHORIZED);
  }

  const sub = (request.user as { sub?: string }).sub;

  if (!sub) {
    return reply.code(401).send(UNAUTHORIZED);
  }

  request.authenticatedUserId = sub;
}

/**
 * Reads the id `requireAuth` established. Throws rather than returning
 * undefined: reaching a handler without it means the guard was left off the
 * route, which is a wiring bug that must fail loudly in development rather
 * than quietly serving another user's scope.
 */
export function authenticatedUserId(request: FastifyRequest): string {
  const id = request.authenticatedUserId;

  if (!id) {
    throw new Error('route is missing the requireAuth preHandler');
  }

  return id;
}
