import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';

export type HealthRouteOptions = {
  database: Database;
  version: string;
};

/**
 * AC-3: 200 + {"status":"ok","database":"connected","version":"..."} when
 * Postgres answers; 503 + {"status":"degraded","database":"disconnected"}
 * when it does not. Never throws — an unreachable database is a reportable
 * condition, not a server error.
 */
export function registerHealthRoute(
  app: FastifyInstance,
  { database, version }: HealthRouteOptions,
): void {
  app.get('/health', {
    schema: {
      tags: ['Health'],
      summary: 'Liveness and database connectivity',
      // EXP-11 NG-1: documentation only. No `body` or `querystring` appears
      // anywhere in this codebase, because declaring one switches on Fastify
      // request validation, which answers 400 before the handler runs.
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            database: { type: 'string' },
            version: { type: 'string' },
          },
        },
        503: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            database: { type: 'string' },
          },
        },
      },
    },
  }, async (_request, reply) => {
    const connected = await database.isReachable();

    if (!connected) {
      return reply
        .code(503)
        .send({ status: 'degraded', database: 'disconnected' });
    }

    return reply
      .code(200)
      .send({ status: 'ok', database: 'connected', version });
  });
}
