import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db.js';
import { consumeVerificationToken } from '../auth/verification.js';
import {
  alreadyVerifiedPage,
  invalidTokenPage,
  verifiedPage,
} from '../email/pages.js';

const querySchema = z.object({
  token: z.string().min(1),
});

export type VerifyRouteOptions = {
  database: Database;
};

/**
 * AC-6 to AC-8. This endpoint is opened by a human in a browser, from a link
 * in an email, so every outcome is an HTML page rather than JSON — including
 * the failures.
 */
export function registerVerifyRoute(
  app: FastifyInstance,
  { database }: VerifyRouteOptions,
): void {
  app.get('/auth/verify', {
    schema: {
      tags: ['Auth'],
      summary: 'Redeem an email verification link',
      description:
        'Opened by a human in a browser from a link in an email, so every outcome is an '
        + 'HTML page rather than JSON — including the failures. A spent link is treated '
        + 'as success, because mail clients prefetch and people double-tap.',
      // EXP-11: no `querystring` schema, or a missing token would return a JSON
      // validation error to a browser instead of the HTML page. No `response`
      // schema either: these replies are HTML, and a schema would JSON-encode
      // them.
    },
  }, async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);

    // A missing or empty token is indistinguishable to the user from a broken
    // one, so it gets the same page rather than a validation error.
    if (!parsed.success) {
      return reply.code(400).type('text/html; charset=utf-8').send(invalidTokenPage);
    }

    const outcome = await database.transaction((client) =>
      consumeVerificationToken(client, parsed.data.token),
    );

    if (outcome.status === 'verified') {
      return reply.code(200).type('text/html; charset=utf-8').send(verifiedPage);
    }

    if (outcome.status === 'already-verified') {
      return reply
        .code(200)
        .type('text/html; charset=utf-8')
        .send(alreadyVerifiedPage);
    }

    return reply.code(400).type('text/html; charset=utf-8').send(invalidTokenPage);
  });
}
