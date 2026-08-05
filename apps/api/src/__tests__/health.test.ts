import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, version } from '../app.js';
import { parseConfig } from '../config.js';
import type { Database } from '../db.js';

const config = parseConfig({
  DATABASE_URL: 'postgres://user:pass@localhost:5432/expenses',
  JWT_SECRET: 'a'.repeat(32),
  PUBLIC_BASE_URL: 'http://localhost:3000',
  LOG_LEVEL: 'silent',
});

/** A Database stand-in whose reachability the test controls. */
function fakeDatabase(reachable: boolean): Database {
  return {
    pool: {} as Database['pool'],
    isReachable: vi.fn(async () => reachable),
    transaction: vi.fn(async () => {
      throw new Error('not used by the health route');
    }),
    close: vi.fn(async () => undefined),
  };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /health', () => {
  // AC-3, connected branch.
  it('returns 200 with status ok when the database is reachable', async () => {
    app = buildApp({ config, database: fakeDatabase(true) });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      database: 'connected',
      version,
    });
  });

  // AC-3, disconnected branch — must report, not throw.
  it('returns 503 with status degraded when the database is unreachable', async () => {
    app = buildApp({ config, database: fakeDatabase(false) });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'degraded',
      database: 'disconnected',
    });
  });

  it('reports a non-empty version string', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
