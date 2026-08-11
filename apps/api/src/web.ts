import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/**
 * EXP-25 AC-7. Serving the built web app from the same origin as the API.
 *
 * Same origin is the whole design: no CORS, one hostname through the tunnel,
 * and the client can use relative paths with no configuration to get wrong.
 *
 * The delicate part is the SPA fallback. A single-page app needs unknown
 * paths to return `index.html` so a deep link like /expenses/123 loads the
 * app rather than 404ing — but if that fallback is applied indiscriminately it
 * also swallows the API's own 404s, and every client error path breaks at
 * once while the app looks completely fine. A client asking for a receipt that
 * does not exist would receive an HTML page with status 200 and try to parse
 * it as JSON.
 *
 * So the fallback is deliberately narrow: it applies only to GET/HEAD requests
 * for paths that are NOT owned by the API.
 */

/**
 * Every prefix the API owns. Anything under one of these 404s as JSON rather
 * than falling back to the app.
 *
 * `/docs` is in the list so its behaviour is unchanged: served in development,
 * a JSON 404 in production — not an HTML page pretending the route exists.
 *
 * This mirrors the proxy list in apps/web/vite.config.ts. A new top-level API
 * prefix must be added to both, or development and production disagree about
 * who owns the path.
 */
export const API_PREFIXES = [
  '/auth',
  '/categories',
  '/receipts',
  '/expenses',
  '/health',
  '/docs',
] as const;

export function isApiPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';

  return API_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/**
 * Where the built app lives, relative to this module once compiled.
 *
 * From `apps/api/dist/web.js` that resolves to `apps/web/dist`, and the
 * production image copies the build to the same place, so one path works in
 * both. Nothing is configurable here on purpose — a wrong value would serve
 * the wrong app or nothing at all, silently.
 */
export function webRoot(): string {
  return fileURLToPath(new URL('../../web/dist', import.meta.url));
}

/**
 * Registers static serving and the fallback, if a build is present.
 *
 * Absent — a plain `npm run dev` on the API, or CI — this does nothing at all
 * and the API behaves exactly as it did before. Development serves the app
 * from Vite instead, so requiring a build to start the API would be pure
 * friction.
 */
export function registerWebApp(app: FastifyInstance, root = webRoot()): boolean {
  if (!existsSync(root)) {
    app.log.info({ root }, 'no web build found; serving API only');
    return false;
  }

  app.register(async (scope) => {
    await scope.register(fastifyStatic, { root, wildcard: false });

    scope.setNotFoundHandler((request, reply) => {
      // A POST or DELETE to an unknown path is a client error, never a page
      // navigation. Returning HTML for one would be nonsense the caller
      // cannot act on.
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return reply.code(404).send({ error: 'Not Found' });
      }

      // The load-bearing branch: the API's own 404s must stay JSON.
      if (isApiPath(request.url)) {
        return reply.code(404).send({ error: 'Not Found' });
      }

      return reply.sendFile('index.html');
    });
  });

  app.log.info({ root }, 'serving the web app');

  return true;
}
