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
  app.get('/health', async (_request, reply) => {
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
