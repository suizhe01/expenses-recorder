import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { parseConfig, type Config } from '../config.js';
import { createDatabase, type Database } from '../db.js';
import type { EmailTransport } from '../email/transport.js';
import { REQUEST_SCHEMAS } from '../openapi/request-schemas.js';
import { methodsOf, routeKey } from '../openapi/transform.js';

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
      '/expenses/export.zip',
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
      // EXP-20 AC-17 and EXP-21 AC-20.
      ['/expenses/export.csv', 'get'],
      ['/expenses/export.zip', 'get'],
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
  it.each(['/expenses/export.csv', '/expenses/export.zip'])(
    'EXP-20 AC-15 and EXP-21 AC-18: %s declares no 200 response schema',
    (path) => {
      const doc = app.swagger() as unknown as {
        paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
      };
      const responses = doc.paths[path]?.get?.responses ?? {};

      expect(Object.keys(responses)).not.toContain('200');
      // The error shapes are still documented.
      expect(Object.keys(responses)).toEqual(
        expect.arrayContaining(['400', '401', '422']),
      );
    },
  );

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

/**
 * EXP-22 — documentation-only request bodies and query parameters.
 *
 * The whole approach rests on one fact: what `transform` returns builds the
 * document and nothing else. `AC-11` below is the test that keeps proving it,
 * and it matters far more than the shape assertions — if the assumption broke,
 * the symptom would not be a wrong document but four silently broken security
 * behaviours, which is exactly what the abandoned `openapi-docs-wip` branch did.
 */
describe('EXP-22: documented requests', () => {
  const BODY_ROUTES = [
    ['post', '/auth/register'],
    ['post', '/auth/login'],
    ['post', '/auth/refresh'],
    ['post', '/auth/logout'],
    ['post', '/auth/resend-verification'],
    ['post', '/auth/forgot-password'],
    ['post', '/auth/reset-password'],
    ['post', '/categories'],
    ['patch', '/categories/{id}'],
    ['post', '/expenses'],
    ['patch', '/expenses/{id}'],
    ['post', '/receipts'],
  ] as const;

  const DELETE_ROUTES = [
    '/categories/{id}',
    '/expenses/{id}',
    '/receipts/{id}',
  ] as const;

  const FILTER_ROUTES = [
    '/expenses',
    '/expenses/export.csv',
    '/expenses/export.zip',
  ] as const;

  type Operation = {
    requestBody?: { content: Record<string, { schema?: Record<string, unknown> }> };
    parameters?: { in: string; name: string; schema?: { type?: string } }[];
  };

  function operation(path: string, method: string): Operation {
    const doc = app.swagger() as unknown as {
      paths: Record<string, Record<string, Operation>>;
    };
    const found = doc.paths[path]?.[method];

    if (!found) {
      throw new Error(`no ${method.toUpperCase()} ${path} in the document`);
    }

    return found;
  }

  /**
   * AC-9. Both directions, driven off the app's real route table.
   *
   * An `onRoute` hook on the root instance also fires for routes registered in
   * the encapsulated scopes below it, which is how this sees all of them.
   * Fastify adds a HEAD route for every GET, so those are excluded alongside GET.
   */
  it('AC-9: every non-GET route is documented, and every entry is a real route', async () => {
    const seen: string[] = [];
    const probe = buildApp({
      config: development,
      database,
      emailTransport: silentTransport,
    });

    probe.addHook('onRoute', (route) => {
      for (const method of methodsOf(route)) {
        seen.push(routeKey(method, route.url));
      }
    });
    await probe.ready();

    try {
      const documented = Object.keys(REQUEST_SCHEMAS).sort();
      const needing = seen
        .filter((key) => !key.startsWith('GET ') && !key.startsWith('HEAD '))
        .sort();

      // Nothing registered is missing from the map...
      expect(needing).toEqual(documented);
      // ...which, being an equality, also proves no entry names a dead route.
      expect(needing.length).toBe(15);
    } finally {
      await probe.close();
    }
  });

  it('AC-3, AC-10: the twelve body-taking routes have a requestBody', () => {
    for (const [method, path] of BODY_ROUTES) {
      const body = operation(path, method).requestBody;

      expect(body, `${method.toUpperCase()} ${path}`).toBeTruthy();
    }
  });

  it('AC-4, AC-10: the three DELETE routes have none', () => {
    for (const path of DELETE_ROUTES) {
      expect(operation(path, 'delete').requestBody, path).toBeUndefined();
    }
  });

  it('AC-5: content types match what each route actually accepts', () => {
    const contentOf = (path: string, method: string) =>
      Object.keys(operation(path, method).requestBody?.content ?? {});

    expect(contentOf('/receipts', 'post')).toEqual(['multipart/form-data']);
    expect(contentOf('/auth/reset-password', 'post')).toEqual([
      'application/x-www-form-urlencoded',
    ]);
    expect(contentOf('/expenses', 'post')).toEqual(['application/json']);
    expect(contentOf('/auth/login', 'post')).toEqual(['application/json']);
  });

  it('AC-5: the upload declares a binary file field, so the UI renders a picker', () => {
    const schema = operation('/receipts', 'post').requestBody?.content[
      'multipart/form-data'
    ]?.schema as { properties?: Record<string, { format?: string }> };

    expect(schema?.properties?.file?.format).toBe('binary');
  });

  /**
   * AC-6. Every documented body prefills Try-it-out, or is named here as unable
   * to.
   *
   * The earlier version of this test skipped anything that was not JSON, which
   * silently excused the only two bodies that failed the criterion. It now walks
   * all twelve and carries exactly one exemption, asserted rather than assumed.
   *
   * Two prefill mechanisms, both confirmed in a browser: Swagger UI fills a JSON
   * editor from the schema's **object-level** `example`, and fills a urlencoded
   * form's individual inputs from each **property's** `example`.
   */
  const CANNOT_PREFILL = new Set(['post /receipts']);

  it('AC-6: every documented body prefills Try-it-out, or is explicitly exempt', () => {
    for (const [method, path] of BODY_ROUTES) {
      const content = operation(path, method).requestBody?.content ?? {};
      const entry = Object.entries(content)[0];

      expect(entry, `${method.toUpperCase()} ${path} has no content`).toBeTruthy();

      const [contentType, media] = entry as [string, { schema?: Record<string, unknown> }];
      const schema = media.schema ?? {};
      const label = `${method.toUpperCase()} ${path}`;

      if (CANNOT_PREFILL.has(`${method} ${path}`)) {
        // A file input takes a file, so no example string could appear in it.
        // Asserting the content type keeps the exemption honest: it stops
        // applying the moment this route stops being an upload.
        expect(contentType, label).toBe('multipart/form-data');
        continue;
      }

      const properties = (schema.properties ?? {}) as Record<string, object>;
      const prefills =
        'example' in schema ||
        (Object.keys(properties).length > 0 &&
          Object.values(properties).every((property) => 'example' in property));

      expect(prefills, `${label} would open with an empty editor`).toBe(true);
    }
  });

  it('AC-7: the three filter routes document all four filters', () => {
    for (const path of FILTER_ROUTES) {
      const query = (operation(path, 'get').parameters ?? []).filter(
        (parameter) => parameter.in === 'query',
      );
      const names = query.map((parameter) => parameter.name).sort();

      expect(names, path).toEqual(['categoryId', 'from', 'hasReceipt', 'to']);

      // Repeatable, which is what makes the UI offer more than one value.
      const categoryId = query.find((parameter) => parameter.name === 'categoryId');
      expect(categoryId?.schema?.type, path).toBe('array');
    }
  });

  it('AC-8: the emailed-link routes document their token', () => {
    for (const path of ['/auth/verify', '/auth/reset-password'] as const) {
      const names = (operation(path, 'get').parameters ?? [])
        .filter((parameter) => parameter.in === 'query')
        .map((parameter) => parameter.name);

      expect(names, path).toContain('token');
    }
  });
});

/**
 * EXP-22 AC-11 — the guarantee the whole issue rests on.
 *
 * Documenting a body must not enforce it. Each request below violates the
 * schema the document now advertises, and each must be answered by the route's
 * own zod parsing rather than by Fastify's validator. Every one of these is 400
 * the moment a real `body` schema is declared on the route.
 */
describe('AC-11: documenting a body does not enable validation', () => {
  it('login still answers 401 for an empty body, not 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {},
    });

    expect(response.statusCode).toBe(401);
  });

  it('register still answers 400 from zod, with a fields object', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'not-an-email', password: 'short' },
    });

    // Fastify's validator would answer `{statusCode, error, message}`; this is
    // the repo's own shape, which proves the handler ran.
    expect(response.statusCode).toBe(400);
    expect(response.json()).toHaveProperty('fields');
    expect(response.json()).toMatchObject({ error: 'Validation failed' });
  });

  it('a wrongly typed expense field reaches the handler', async () => {
    // No token, so the guard answers first — 401 rather than Fastify's 400 is
    // itself the evidence: validation would have run before the preHandler.
    const response = await app.inject({
      method: 'POST',
      url: '/expenses',
      payload: { totalCents: 'not-a-number', categoryId: 'nope' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('the upload route still refuses a non-multipart body its own way', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/receipts',
      payload: { file: 'not a file at all' },
    });

    // 401 from the guard, never a 415 or 400 from a schema.
    expect(response.statusCode).toBe(401);
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
