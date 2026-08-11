import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { API_PREFIXES, isApiPath, registerWebApp } from '../web.js';

/**
 * EXP-25 AC-7. The SPA fallback must not shadow the API.
 *
 * This is the criterion whose failure is invisible: if `index.html` is
 * returned for unknown API paths, nothing about the app looks broken while
 * every client error path silently becomes an HTML page. A client asking for a
 * receipt that does not exist would parse a web page as JSON.
 *
 * A real directory is used rather than a mock, because the thing under test is
 * the interaction between @fastify/static and the not-found handler.
 */

const MARKER = '<!doctype html><title>web app</title>';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'web-dist-'));
  writeFileSync(join(root, 'index.html'), MARKER);
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1);');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A stand-in API with one route per prefix, so the fallback has real
 *  neighbours to be wrong about. */
async function buildHarness(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/expenses', async () => []);
  app.get('/auth/verify', async (_request, reply) =>
    reply.type('text/html').send('<html>verify</html>'),
  );

  registerWebApp(app, root);
  await app.ready();

  return app;
}

describe('isApiPath', () => {
  it('claims every API prefix and their children', () => {
    for (const prefix of API_PREFIXES) {
      expect(isApiPath(prefix)).toBe(true);
      expect(isApiPath(`${prefix}/anything`)).toBe(true);
      expect(isApiPath(`${prefix}?a=b`)).toBe(true);
    }
  });

  it('claims nothing else', () => {
    for (const path of ['/', '/sign-in', '/index.html', '/assets/app.js']) {
      expect(isApiPath(path)).toBe(false);
    }
  });

  /**
   * `/expenses-something` is not under `/expenses`. Matching on a bare
   * `startsWith` without the separator would claim it and 404 a legitimate app
   * route.
   */
  it('does not claim a path that merely shares a prefix string', () => {
    expect(isApiPath('/expenseshistory')).toBe(false);
    expect(isApiPath('/authorised')).toBe(false);
  });
});

describe('serving the web app (AC-7)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildHarness();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves index.html at the root', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('web app');
  });

  it('serves built assets', async () => {
    const response = await app.inject({ method: 'GET', url: '/assets/app.js' });

    expect(response.statusCode).toBe(200);
  });

  it('falls back to index.html for an unknown app route', async () => {
    // A deep link into the SPA. Without this, refreshing on /sign-in 404s.
    const response = await app.inject({ method: 'GET', url: '/sign-in' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('web app');
  });

  /**
   * THE one that matters. Every assertion here is about NOT returning the app.
   */
  it('answers JSON 404 for an unknown API path, never index.html', async () => {
    for (const url of [
      '/auth/nonexistent',
      '/expenses/nope/deeper',
      '/receipts/00000000-0000-0000-0000-000000000000/nothing',
      '/categories/unknown/sub',
      '/health/extra',
      '/docs/missing',
    ]) {
      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode, url).toBe(404);
      expect(response.body, url).not.toContain('web app');
      expect(() => JSON.parse(response.body), url).not.toThrow();
    }
  });

  it('answers JSON 404 for a non-GET to an unknown path', async () => {
    // A POST is never a page navigation; HTML would be unusable to the caller.
    const response = await app.inject({ method: 'POST', url: '/whatever' });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('web app');
  });

  it('leaves real API routes untouched', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/expenses' })).statusCode).toBe(200);
  });

  it('leaves the server-rendered HTML routes untouched', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/verify' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('verify');
    expect(response.body).not.toContain('web app');
  });
});

describe('when no build is present', () => {
  it('registers nothing and leaves the API alone', async () => {
    const app = Fastify({ logger: false });
    app.get('/health', async () => ({ status: 'ok' }));

    const registered = registerWebApp(app, join(tmpdir(), 'definitely-not-here'));
    await app.ready();

    try {
      expect(registered).toBe(false);

      // The default Fastify 404, not an HTML page.
      const missing = await app.inject({ method: 'GET', url: '/anything' });
      expect(missing.statusCode).toBe(404);
      expect(missing.headers['content-type']).toContain('application/json');
    } finally {
      await app.close();
    }
  });
});
