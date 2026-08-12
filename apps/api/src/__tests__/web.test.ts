import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/**
 * EXP-37. The web app's route table, read as text out of
 * apps/web/src/client-routes.ts.
 *
 * Read rather than imported: apps/web is a separate TypeScript project with
 * DOM-only settings, so importing it here would pull its whole type graph into
 * this workspace's typecheck. Reading it still means a route moved back under
 * an API prefix fails these tests, which is the point — the previous version of
 * this bug shipped because nothing connected the client's paths to the server's
 * fallback.
 */
const CLIENT_ROUTES_TS = fileURLToPath(
  new URL('../../../web/src/client-routes.ts', import.meta.url),
);

function clientRouteEntries(): Map<string, string> {
  const source = readFileSync(CLIENT_ROUTES_TS, 'utf8');
  const declaration = /export const CLIENT_ROUTES = \{([^}]*)\}/.exec(source);
  if (!declaration) {
    throw new Error(`could not find CLIENT_ROUTES in ${CLIENT_ROUTES_TS}`);
  }

  return new Map(
    [...declaration[1]!.matchAll(/(\w+):\s*'([^']+)'/g)].map(
      (match) => [match[1]!, match[2]!] as const,
    ),
  );
}

/** Every routable path. The catch-all is not a URL anyone loads. */
function clientRoutes(): string[] {
  return [...clientRouteEntries().values()].filter((route) => route !== '*');
}

function clientRoute(name: string): string {
  const route = clientRouteEntries().get(name);
  if (!route) throw new Error(`no client route named ${name}`);
  return route;
}

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
   * EXP-37 AC-3 and AC-8. The client routes that a user actually types,
   * reloads or pastes.
   *
   * This is the assertion the original bug slipped past: the web suite renders
   * with no server, so clicking through to a colliding route works while a
   * direct load answers JSON. Here the request reaches the real fallback, with
   * `/expenses` registered above as a genuine API neighbour — move the confirm
   * screen back under `/receipts/` or the list back to `/expenses` and these
   * stop returning the app.
   */
  it('serves the app for a direct load of every declared client route', async () => {
    const routes = clientRoutes();

    // A parse that quietly returned nothing would make this vacuously true.
    expect(routes.length).toBeGreaterThanOrEqual(5);

    for (const route of routes) {
      const url = route.replaceAll(/:[A-Za-z]+/g, '00000000-0000-0000-0000-000000000000');
      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode, url).toBe(200);
      expect(response.body, url).toContain('web app');
    }
  });

  it('serves the app for a filtered list URL, so a reload and a shared link work', async () => {
    // EXP-30 AC-9 promised this and `/expenses` silently broke it.
    const url = `${clientRoute('expenses')}?from=2026-08-01&categoryId=cat-1&hasReceipt=true`;
    const response = await app.inject({ method: 'GET', url });

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
