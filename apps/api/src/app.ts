import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyFormbody from '@fastify/formbody';
import fastifyMultipart from '@fastify/multipart';
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
};

export function buildApp({
  config,
  database,
  emailTransport,
}: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
  });

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

  registerHealthRoute(app, { database, version });

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
    await scope.register(fastifyRateLimit, { global: false });
    await scope.register(fastifyMultipart, {
      limits: { files: 1, fileSize: config.MAX_UPLOAD_BYTES },
    });

    registerReceiptRoutes(scope, { config, database });
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
