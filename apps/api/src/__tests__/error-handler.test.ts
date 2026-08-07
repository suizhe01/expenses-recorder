import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { parseConfig } from '../config.js';
import { createDatabase, type Database } from '../db.js';

/**
 * EXP-14 AC-2 to AC-4 — the global error handler.
 *
 * Fastify's default writes a thrown error's `message` into the response body.
 * For a 5xx that message comes from whatever failed, and can carry anything it
 * happens to mention — an ENOENT names the absolute path it tried to open,
 * which is how a missing receipt file was disclosing the storage layout, the
 * owner's id and the content hash.
 */
const config = parseConfig({
  ...process.env,
  JWT_SECRET: 'test-secret-at-least-thirty-two-chars',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  LOG_LEVEL: 'silent',
});

let database: Database;
let app: FastifyInstance;

/** Routes that exist only to be thrown from; the handler is what is under test. */
function buildAppWithThrowingRoutes(): FastifyInstance {
  const instance = buildApp({ config, database });

  instance.get('/__test/server-error', async () => {
    throw new Error(
      "ENOENT: no such file or directory, open '/data/receipts/secret-user/secret-hash'",
    );
  });

  instance.get('/__test/client-error', async () => {
    const error = new Error('that password is too short') as Error & {
      statusCode: number;
    };
    error.statusCode = 400;
    throw error;
  });

  instance.get('/__test/teapot', async () => {
    const error = new Error('I am a teapot') as Error & { statusCode: number };
    error.statusCode = 418;
    throw error;
  });

  return instance;
}

beforeAll(async () => {
  database = createDatabase(config);
  app = buildAppWithThrowingRoutes();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

describe('global error handler', () => {
  it('AC-2: a 5xx reveals nothing beyond the status', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/__test/server-error',
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'Internal Server Error' });

    // None of what the thrown message happened to contain.
    expect(response.body).not.toContain('ENOENT');
    expect(response.body).not.toContain('/data/receipts');
    expect(response.body).not.toContain('secret-user');
    expect(response.body).not.toContain('secret-hash');
    expect(response.body).not.toContain('stack');
  });

  it('AC-3: a thrown 4xx keeps its status and its message', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/__test/client-error',
    });

    expect(response.statusCode).toBe(400);
    // The message is written by this codebase and is the point of the reply.
    expect(response.body).toContain('that password is too short');
  });

  it('AC-3: any 4xx passes through, not just the familiar ones', async () => {
    const response = await app.inject({ method: 'GET', url: '/__test/teapot' });

    expect(response.statusCode).toBe(418);
    expect(response.body).toContain('I am a teapot');
  });

  it('AC-4: a route that never throws is untouched', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    // /health builds its 200 and its 503 with reply.send, so the handler never
    // sees them.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', database: 'connected' });
  });

  it('AC-3: an unknown route still returns Fastify 404, not a generic 500', async () => {
    const response = await app.inject({ method: 'GET', url: '/__test/nowhere' });

    expect(response.statusCode).toBe(404);
  });
});
