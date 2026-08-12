import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLIENT_ROUTES } from '@/client-routes';

/**
 * EXP-37 AC-4. No client route may begin with an API prefix.
 *
 * This has shipped twice — `/receipts/:id/confirm` and `/expenses` — and both
 * times every test passed, because the web suite renders in happy-dom with no
 * server, where client-side routing to a colliding path works perfectly. The
 * damage only appears on a direct load, a reload or a shared link, where the
 * request actually reaches Fastify (production: the SPA fallback refuses API
 * paths; development: Vite proxies them) and answers a JSON 404.
 *
 * `API_PREFIXES` is read out of the API source rather than copied, so this test
 * cannot drift out of date when a new prefix is added there.
 */

// Vitest runs with apps/web as the working directory. `import.meta.url` is a
// dev-server http URL under Vite, so it cannot be resolved to a file path here.
const WEB_TS = resolve(process.cwd(), '../api/src/web.ts');
const APP_TSX = resolve(process.cwd(), 'src/app.tsx');

function apiPrefixes(): string[] {
  const source = readFileSync(WEB_TS, 'utf8');
  const declaration = /export const API_PREFIXES = \[([^\]]*)\]/.exec(source);
  if (!declaration) {
    throw new Error(`could not find API_PREFIXES in ${WEB_TS}`);
  }
  return [...declaration[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
}

/** Mirrors `isApiPath` in apps/api/src/web.ts: a prefix owns itself and
 *  everything beneath it, but not a path that merely shares its spelling. */
function collidesWithApi(route: string, prefixes: string[]): boolean {
  const path = route.split('?')[0] ?? '';
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

describe('client routes never collide with an API prefix (AC-4)', () => {
  it('reads the real prefix list out of the API source', () => {
    // Guards the parse itself: a silently empty list would make every
    // assertion below vacuously true, which is the failure mode this repo has
    // been bitten by before.
    const prefixes = apiPrefixes();

    expect(prefixes.length).toBeGreaterThanOrEqual(6);
    expect(prefixes).toContain('/expenses');
    expect(prefixes).toContain('/receipts');
  });

  it('catches a deliberately colliding route', () => {
    const prefixes = apiPrefixes();

    expect(collidesWithApi('/expenses', prefixes)).toBe(true);
    expect(collidesWithApi('/expenses/abc', prefixes)).toBe(true);
    expect(collidesWithApi('/receipts/:id/confirm', prefixes)).toBe(true);
    expect(collidesWithApi('/expenses?from=2026-08-01', prefixes)).toBe(true);
    // Sharing a prefix string is not being under it.
    expect(collidesWithApi('/expense', prefixes)).toBe(false);
  });

  it('declares no colliding route', () => {
    const prefixes = apiPrefixes();

    for (const route of Object.values(CLIENT_ROUTES)) {
      expect(collidesWithApi(route, prefixes), route).toBe(false);
    }
  });

  /**
   * Without this, a new `<Route path="/expenses/:id">` written straight into
   * the route table would escape the check above entirely — which is precisely
   * how the third collision was about to ship.
   */
  it('leaves the route table with no path the check cannot see', () => {
    const source = readFileSync(APP_TSX, 'utf8');
    const literals = [...source.matchAll(/path=(["'][^"']*["'])/g)].map((match) => match[1]!);

    expect(literals).toEqual([]);
    expect(source).toContain('path={CLIENT_ROUTES.');
  });
});
