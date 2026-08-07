import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyFormbody from '@fastify/formbody';
import fastifyMultipart from '@fastify/multipart';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { createRequire } from 'node:module';
import type { Config } from './config.js';
import type { Database } from './db.js';
import { registerHealthRoute } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerVerifyRoute } from './routes/verify.js';
import { registerResetPasswordRoutes } from './routes/reset-password.js';
import { registerCategoryRoutes } from './routes/categories.js';
import { registerReceiptRoutes } from './routes/receipts.js';
import { createConsoleTransport, type EmailTransport } from './email/transport.js';
import { createResendTransport } from './email/resend.js';
import {
  createGeminiExtractor,
  createSkippingExtractor,
  type ReceiptExtractor,
} from './receipts/extraction.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const version: string = pkg.version;

export type BuildAppOptions = {
  config: Config;
  database: Database;
  /**
   * Defaults to the console transport (EXP-8 NG-1). Injectable so tests can
   * observe what would have been sent without reading log output.
   */
  emailTransport?: EmailTransport;
  /**
   * Defaults to Gemini when a key is configured, and to a skipping extractor
   * otherwise (EXP-15 AC-7). Injectable so tests never reach the network —
   * not merely because CI has no key, but because the model's output varies
   * between runs and an assertion on a merchant name would flake (AC-15).
   */
  extractor?: ReceiptExtractor;
};

export function buildApp({
  config,
  database,
  emailTransport,
  extractor,
}: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
  });

  // EXP-14 AC-2 to AC-4. Set on the root instance, so every scope below
  // inherits it and any route added later is covered without being remembered.
  //
  // Fastify's default serialises a thrown error's `message` into the response.
  // For a 5xx that message is written by whatever failed — an ENOENT, for
  // instance, carries the absolute path it tried to open, which is how a
  // missing receipt file was handing out the storage layout, the owner's id
  // and the content hash. Nothing a client can act on is lost by replacing it:
  // a 5xx means the server failed, and the detail belongs in the log.
  //
  // 4xx is passed straight through. Those messages are written by this
  // codebase and are the whole point of the response — "must be at least 12
  // characters", the rate limiter's retry advice — and re-sending the error
  // keeps the default serialisation and any headers already set on the reply,
  // such as `Retry-After`.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;

    if (statusCode < 500) {
      return reply.code(statusCode).send(error);
    }

    request.log.error({ err: error }, 'request failed');

    return reply.code(statusCode).send({ error: 'Internal Server Error' });
  });

  // EXP-11 AC-1. Generating the document registers no routes of its own, so
  // this is safe in every environment; only the UI below is gated.
  app.register(fastifySwagger, {
    openapi: {
      // 3.1.0 rather than the plugin's 3.0.3 default. Fastify's schemas are
      // JSON Schema, and 3.1 is the OpenAPI version aligned with it — 3.0.x
      // forbids the `type: ['string', 'null']` that expresses a nullable
      // field, which is how `originalFilename` made the document invalid
      // against the version it declared.
      openapi: '3.1.0',
      info: {
        title: 'Expenses Recorder API',
        description:
          'Receipt capture and expense archive for a Malaysian individual. ' +
          'Amounts are integer cents in MYR; timestamps are UTC.',
        version,
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
      tags: [
        { name: 'Health', description: 'Liveness and database connectivity' },
        { name: 'Auth', description: 'Registration, sessions, verification, password reset' },
        { name: 'Categories', description: 'User-owned expense categories' },
        { name: 'Receipts', description: 'Receipt images' },
      ],
    },
  });

  // AC-2: the browsable UI is development-only. The deploy runbook puts this
  // API on a public Cloudflare Tunnel, where /docs would hand anyone who found
  // it a complete map of the auth surface. The document itself stays available
  // for codegen through `npm run openapi`, which needs no server.
  if (config.NODE_ENV !== 'production') {
    app.register(fastifySwaggerUi, { routePrefix: '/docs' });
  }

  app.register(fastifyJwt, { secret: config.JWT_SECRET });

  // AC-1: Resend when a key is present, the console transport otherwise, so
  // local development and CI need no account, no key, and no network.
  const transport =
    emailTransport ??
    (config.RESEND_API_KEY
      ? createResendTransport({
          apiKey: config.RESEND_API_KEY,
          from: config.MAIL_FROM,
        })
      : createConsoleTransport(app.log));

  app.log.info(
    { transport: transport.name, from: config.MAIL_FROM },
    'email transport selected',
  );

  // AC-7: no key means skip, not fail. A failing extractor would make every
  // keyless machine look like Gemini was broken and bury a real outage in the
  // noise.
  const receiptExtractor =
    extractor ??
    (config.GEMINI_API_KEY
      ? createGeminiExtractor({
          apiKey: config.GEMINI_API_KEY,
          model: config.GEMINI_MODEL,
        })
      : createSkippingExtractor(config.GEMINI_MODEL));

  app.log.info(
    {
      extraction: config.GEMINI_API_KEY || extractor ? 'enabled' : 'skipped',
      model: receiptExtractor.model,
    },
    'receipt extraction configured',
  );

  // EXP-11 AC-1: inside a `register` callback rather than called directly.
  // `app.register` defers, so a route added straight to the root instance is
  // created before the Swagger plugin has loaded and its `onRoute` hook exists
  // — which left /health out of the document entirely. Queuing it keeps it in
  // order behind Swagger.
  //
  // AC-8: still outside the rate-limited scope, so /health stays unlimited, and
  // still free of the category guard's preHandler.
  app.register(async (scope) => {
    registerHealthRoute(scope, { database, version });
  });

  // EXP-12 AC-13: deliberately OUTSIDE the rate-limited scope below. That
  // 10/min budget is sized for unauthenticated login attempts; an app browsing
  // and editing a category list would exhaust it in ordinary use. Access still
  // requires a valid token.
  //
  // Registered in its own encapsulated scope because registerCategoryRoutes
  // installs a preHandler — on the root instance that hook would also run for
  // /health, which must stay unauthenticated.
  app.register(async (scope) => {
    registerCategoryRoutes(scope, { database });
  });

  // EXP-13: receipts get their own scope for the same reason — the guard is a
  // preHandler and must not escape. Unlike categories, a limiter is registered
  // here with `global: false`, so it applies only to the upload route that
  // opts in (AC-13). An unbounded 10MB write is a different risk from an
  // unbounded row insert.
  app.register(async (scope) => {
    await scope.register(fastifyRateLimit, {
      global: false,
      // AC-13 counts per ACCOUNT. The plugin's default key is the client IP,
      // which is wrong here in three ways, the last of them serious: one
      // account on two networks would get double the budget, two accounts
      // behind one NAT would share a single budget, and behind the Cloudflare
      // Tunnel of the deploy issue every request carries the tunnel's address
      // — collapsing the limit into one global bucket for the whole system.
      keyGenerator: (request) => request.authenticatedUserId ?? request.ip,
      // The default `onRequest` runs before any preHandler, so the id would
      // not be set yet. A route-level preHandler runs after the instance-level
      // preHandler that `requireAuth` is registered as, which is what makes
      // the key above available.
      hook: 'preHandler',
    });
    await scope.register(fastifyMultipart, {
      limits: { files: 1, fileSize: config.MAX_UPLOAD_BYTES },
    });

    registerReceiptRoutes(scope, { config, database, extractor: receiptExtractor });
  });

  // AC-11: the rate limiter is registered inside an encapsulated scope so it
  // applies to the auth routes only. /health is registered on the root
  // instance above and is therefore never limited.
  app.register(async (scope) => {
    await scope.register(fastifyRateLimit, {
      max: 10,
      timeWindow: '1 minute',
    });

    // EXP-10: the reset form posts application/x-www-form-urlencoded, which
    // Fastify has no parser for out of the box. Registered on this scope only,
    // so the JSON endpoints elsewhere are unaffected.
    await scope.register(fastifyFormbody);

    registerAuthRoutes(scope, { config, database, emailTransport: transport });
    registerVerifyRoute(scope, { database });

    // EXP-10 NG-4: inside the same scope, so the reset routes inherit the
    // 10/min limit above rather than introducing a second limiter.
    registerResetPasswordRoutes(scope, {
      config,
      database,
      emailTransport: transport,
    });
  });

  return app;
}
