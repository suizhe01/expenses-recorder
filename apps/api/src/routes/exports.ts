import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import { authenticatedUserId } from '../auth/guard.js';
import { createDownloadToken } from '../exports/tokens.js';

export function registerExportTokenRoute(
  app: FastifyInstance,
  { database }: { database: Database },
): void {
  app.post('/exports/token', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['Expenses'],
      summary: 'Create a one-minute, single-use export download token',
      description:
        'Requires bearer authentication. Returns an opaque token for exactly one '
        + 'CSV or ZIP export download within 60 seconds. It cannot authenticate any '
        + 'other endpoint and cannot be renewed.',
      security: [{ bearerAuth: [] }],
      response: {
        201: {
          type: 'object',
          properties: {
            token: { type: 'string' },
            expiresAt: { type: 'string', format: 'date-time' },
          },
        },
        401: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
  }, async (request, reply) => {
    const download = await createDownloadToken(
      database.pool,
      authenticatedUserId(request),
    );

    return reply.code(201).send({
      token: download.token,
      expiresAt: download.expiresAt.toISOString(),
    });
  });
}
