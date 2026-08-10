import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { parseConfig, type Config } from '../config.js';
import { createDatabase, type Database } from '../db.js';
import type { EmailTransport } from '../email/transport.js';

const base = {
  ...process.env,
  JWT_SECRET: 'test-secret-at-least-thirty-two-chars',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  LOG_LEVEL: 'silent',
} as NodeJS.ProcessEnv;

const development: Config = parseConfig({ ...base, NODE_ENV: 'development' });
const production: Config = parseConfig({ ...base, NODE_ENV: 'production' });

const silentTransport: EmailTransport = {
  name: 'silent',
  sendVerificationEmail: async () => {},
  sendPasswordResetEmail: async () => {},
};

let database: Database;
let app: FastifyInstance;

beforeAll(async () => {
  database = createDatabase(development);
  app = buildApp({ config: development, database, emailTransport: silentTransport });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

type Document = {
  openapi: string;
  paths: Record<string, Record<string, { security?: unknown[] }>>;
  components?: { securitySchemes?: Record<string, unknown> };
};

function document(): Document {
  return app.swagger() as unknown as Document;
}

describe('the OpenAPI document', () => {
  it('AC-1: describes every route the API serves', () => {
    const paths = Object.keys(document().paths);

    for (const expected of [
      '/health',
      '/auth/register',
      '/auth/login',
      '/auth/refresh',
      '/auth/logout',
      '/auth/me',
      '/auth/verify',
      '/auth/resend-verification',
      '/auth/forgot-password',
      '/auth/reset-password',
      '/categories',
      '/categories/{id}',
      '/receipts',
      '/receipts/{id}',
      '/receipts/{id}/file',
      '/expenses',
      '/expenses/{id}',
      '/expenses/export.csv',
    ]) {
      expect(paths).toContain(expected);
    }
  });

  /** EXP-16 AC-21. The tag has to be declared, not merely referenced by a route. */
  it('AC-1: declares the Expenses tag and puts every expense route under it', () => {
    const doc = app.swagger() as unknown as {
      tags?: { name: string }[];
      paths: Record<string, Record<string, { tags?: string[] }>>;
    };

    expect(doc.tags?.map((tag) => tag.name)).toContain('Expenses');

    for (const [path, method] of [
      ['/expenses', 'get'],
      ['/expenses', 'post'],
      ['/expenses/{id}', 'get'],
      ['/expenses/{id}', 'patch'],
      ['/expenses/{id}', 'delete'],
      // EXP-20 AC-17.
      ['/expenses/export.csv', 'get'],
    ] as const) {
      expect(doc.paths[path]?.[method]?.tags, `${method} ${path}`).toContain('Expenses');
    }
  });

  /**
   * EXP-20 AC-15. A Fastify response schema is an allowlist applied by the
   * serialiser, so declaring one for the export's 200 would hand a streamed CSV
   * to a JSON serialiser. The 4xx schemas must stay — those responses really are
   * JSON — which is why this asserts on the 200 specifically rather than on the
   * absence of `response` altogether.
   */
  it('AC-15: the CSV export declares no 200 response schema', () => {
    const doc = app.swagger() as unknown as {
      paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
    };
    const responses = doc.paths['/expenses/export.csv']?.get?.responses ?? {};

    expect(Object.keys(responses)).not.toContain('200');
    // The error shapes are still documented.
    expect(Object.keys(responses)).toEqual(
      expect.arrayContaining(['400', '401', '422']),
    );
  });

  it('AC-1: is a valid OpenAPI 3 document', () => {
    expect(document().openapi).toMatch(/^3\./);
  });

  /**
   * The version the document declares has to match the JSON Schema dialect its
   * schemas actually use. Fastify serialises with JSON Schema, where a nullable
   * field is `type: ['string', 'null']` — legal in OpenAPI 3.1, forbidden in
   * 3.0.x, which spells it `nullable: true`. The document previously claimed
   * 3.0.3 while containing type arrays, so it was invalid against its own
   * header and a strict generator could have rejected it.
   *
   * Asserting the version string alone cannot catch that, which is exactly how
   * it got through.
   */
  it('AC-1: declares a version whose dialect matches the schemas it contains', () => {
    const doc = document();
    const typeArrays: string[] = [];

    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => walk(item, `${path}[${index}]`));
        return;
      }

      if (node === null || typeof node !== 'object') {
        return;
      }

      for (const [key, value] of Object.entries(node)) {
        if (key === 'type' && Array.isArray(value)) {
          typeArrays.push(path);
        }
        walk(value, `${path}.${key}`);
      }
    };

    walk(doc.paths, 'paths');

    // These exist deliberately — `originalFilename` is genuinely nullable —
    // so the document must declare a version that permits them.
    expect(typeArrays.length).toBeGreaterThan(0);
    expect(
      doc.openapi,
      `type arrays at ${typeArrays.join(', ')} require OpenAPI 3.1 or later`,
    ).toMatch(/^3\.[1-9]/);
  });

  it('AC-6: marks the authenticated routes as requiring a bearer token', () => {
    const doc = document();

    expect(doc.components?.securitySchemes).toHaveProperty('bearerAuth');
    expect(doc.paths['/auth/me']?.get?.security).toBeTruthy();
    expect(doc.paths['/categories']?.get?.security).toBeTruthy();
    expect(doc.paths['/receipts']?.post?.security).toBeTruthy();

    // Public routes must not claim to need one.
    expect(doc.paths['/health']?.get?.security).toBeUndefined();
    expect(doc.paths['/auth/login']?.post?.security).toBeUndefined();
  });
});

describe('AC-2: Swagger UI is development-only', () => {
  it('serves /docs outside production', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs' });

    // The plugin redirects /docs to /docs/static/index.html.
    expect([200, 302]).toContain(response.statusCode);
  });

  it('does not register /docs in production', async () => {
    const productionApp = buildApp({
      config: production,
      database,
      emailTransport: silentTransport,
    });
    await productionApp.ready();

    try {
      const response = await productionApp.inject({ method: 'GET', url: '/docs' });

      expect(response.statusCode).toBe(404);
    } finally {
      await productionApp.close();
    }
  });
});

describe('AC-3: no route declares a request schema', () => {
  it('has no body, querystring, or params schema anywhere under routes', async () => {
    const directory = new URL('../routes/', import.meta.url);
    const files = await readdir(directory);

    for (const file of files) {
      const source = await readFile(new URL(file, directory), 'utf8');

      // Any of the three switches on Fastify request validation, which answers
      // 400 before the handler runs. `params` is included because a uuid check
      // would turn EXP-12's deliberate 404 into a 400.
      expect(source, `${file} declares a request schema`).not.toMatch(
        /^\s*(body|querystring|params):/m,
      );
    }
  });
});

/**
 * AC-4 — the four behaviours the abandoned `openapi-docs-wip` branch broke by
 * declaring request schemas. Each of these fails the moment validation is
 * reintroduced on the route in question.
 */
describe('AC-4: validation stays with zod', () => {
  it('login answers an identical 401 for a malformed body and a short password', async () => {
    const malformed = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {},
    });
    const tooShort = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'someone@example.com', password: 'short' },
    });

    // 400 here would let an attacker tell "too short" from "wrong", which is
    // what the comment in auth.ts exists to prevent.
    expect(malformed.statusCode).toBe(401);
    expect(tooShort.statusCode).toBe(401);
    expect(tooShort.body).toBe(malformed.body);
  });

  it('resend-verification answers 202 for a malformed body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/resend-verification',
      payload: {},
    });

    expect(response.statusCode).toBe(202);
  });

  it('logout answers 204 with no token at all', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      payload: {},
    });

    expect(response.statusCode).toBe(204);
  });

  it('verify answers an HTML page for a missing token', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/verify' });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('no longer valid');
  });
});
