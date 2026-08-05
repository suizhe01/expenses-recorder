import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyRateLimit from '@fastify/rate-limit';
import { createRequire } from 'node:module';
import type { Config } from './config.js';
import type { Database } from './db.js';
import { registerHealthRoute } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerVerifyRoute } from './routes/verify.js';
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

  // AC-11: the rate limiter is registered inside an encapsulated scope so it
  // applies to the auth routes only. /health is registered on the root
  // instance above and is therefore never limited.
  app.register(async (scope) => {
    await scope.register(fastifyRateLimit, {
      max: 10,
      timeWindow: '1 minute',
    });

    registerAuthRoutes(scope, { config, database, emailTransport: transport });
    registerVerifyRoute(scope, { database });
  });

  return app;
}
