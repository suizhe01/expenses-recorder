import { z } from 'zod';

/**
 * Every environment variable the API reads. Anything not listed here is
 * ignored, so a typo in `.env` surfaces as a missing-variable error rather
 * than silently taking a default.
 */
const configSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((value) => /^postgres(ql)?:\/\//.test(value), {
      message: 'must be a postgres:// or postgresql:// connection string',
    }),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  // HS256 signing key for access tokens. 32 characters is the floor for a
  // secret that must resist offline brute force if a token ever leaks.
  JWT_SECRET: z
    .string()
    .min(32, { message: 'must be at least 32 characters' }),
  // Origin the API is reached on, used to build verification links. It cannot
  // be derived from the request: a link is built for an email that will be
  // opened elsewhere, and trusting the Host header would let a caller mint
  // links pointing at a domain they control.
  PUBLIC_BASE_URL: z
    .string()
    .min(1)
    .refine(
      (value) => {
        try {
          const url = new URL(value);
          return url.protocol === 'http:' || url.protocol === 'https:';
        } catch {
          return false;
        }
      },
      { message: 'must be an absolute http:// or https:// URL' },
    ),
  // Optional. When absent the console transport is used, so local development
  // and CI work with no account, no key, and no network.
  //
  // An empty string is treated as absent: docker compose expands an unset
  // `${RESEND_API_KEY:-}` to "", and rejecting that would stop the API booting
  // for anyone who has not signed up for Resend.
  RESEND_API_KEY: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(1).optional(),
  ),
  // Resend's shared test sender. It needs no domain or DNS, but only delivers
  // to the address on the Resend account — swap for your own domain to reach
  // anyone else.
  MAIL_FROM: z
    .string()
    .email({ message: 'must be a valid email address' })
    .default('onboarding@resend.dev'),
  // EXP-23 AC-4. Whether `X-Forwarded-For` may be believed. Off by default:
  // an unproxied API that trusts the header lets any caller claim any address,
  // which would let one client evade the auth rate limit by varying it.
  //
  // Deliberately NOT `z.coerce.boolean()`. That coerces by JavaScript
  // truthiness, so the string "false" — the exact value an operator writes to
  // turn this off — becomes `true`, silently trusting a spoofable header while
  // the configuration says otherwise. The enum below rejects anything that is
  // not "true" or "false" and names the variable when it does.
  //
  // Empty counts as absent, matching RESEND_API_KEY and GEMINI_API_KEY: docker
  // compose expands an unset `${TRUST_PROXY:-}` to "", and failing on that
  // would stop the API booting for anyone who has not set it.
  TRUST_PROXY: z.preprocess(
    (value) => (value === '' || value === undefined ? 'false' : value),
    z
      .enum(['true', 'false'], {
        message: 'must be exactly "true" or "false"',
      })
      .transform((value) => value === 'true'),
  ),
  // EXP-13 AC-14. Where receipt images are written. The default is relative to
  // the working directory so a bare `npm run dev` works with no setup; compose
  // overrides it with a named volume so the archive survives a rebuild.
  RECEIPTS_PATH: z.string().min(1).default('./data/receipts'),
  // Largest single upload, in bytes. A 12MP phone photo is 2–5MB, so 10MB
  // accepts every real receipt while bounding what one request can write to a
  // home disk.
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10_485_760),
  // EXP-15 AC-7, AC-14. Optional for the same reason `RESEND_API_KEY` is:
  // absent selects an extractor that skips rather than one that fails, so CI
  // and a fresh clone run with no key and no network.
  //
  // An empty string counts as absent — docker compose expands an unset
  // `${GEMINI_API_KEY:-}` to "", and rejecting that would stop the API booting
  // for anyone who has not signed up.
  GEMINI_API_KEY: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(1).optional(),
  ),
  // AC-11. In config so a model upgrade needs no code change; recorded on every
  // attempt row so an old reading always says which model produced it.
  GEMINI_MODEL: z.string().min(1).default('gemini-3.6-flash'),
  // Optional outside Compose. In production the API receives the internal
  // service URL; leaving it unset keeps a bare local API usable with Gemini.
  PADDLEOCR_BASE_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().url().refine((value) => new URL(value).protocol === 'http:', {
      message: 'must be an absolute http:// URL',
    }).optional(),
  ),
  // Explicitly opt in. A reachable service URL alone must not unexpectedly
  // send a receipt to OCR, and the string "false" must stay false.
  PADDLEOCR_ENABLED: z.preprocess(
    (value) => (value === '' || value === undefined ? 'false' : value),
    z
      .enum(['true', 'false'], {
        message: 'must be exactly "true" or "false"',
      })
      .transform((value) => value === 'true'),
  ),
  PADDLEOCR_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
});

export type Config = z.infer<typeof configSchema>;

/**
 * The subset of the schema a database-only entry point needs. Derived from
 * `configSchema` rather than restated, so `DATABASE_URL` is validated by
 * exactly the same rule and produces exactly the same error message.
 *
 * Maintenance scripts use this so they do not demand unrelated secrets:
 * pruning sessions has no business requiring `JWT_SECRET`, and an operator
 * running it from cron should not have to supply one.
 */
const databaseConfigSchema = configSchema.pick({ DATABASE_URL: true });

export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;

/**
 * Raised when the environment fails validation. `issues` names every offending
 * variable so the operator can fix them all in one pass rather than one per
 * restart.
 */
export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

function toIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const variable = issue.path.join('.') || '(root)';
    return `${variable}: ${issue.message}`;
  });
}

/**
 * Pure parse of the database-only subset — throws ConfigError, never exits.
 */
export function parseDatabaseConfig(
  env: NodeJS.ProcessEnv = process.env,
): DatabaseConfig {
  const result = databaseConfigSchema.safeParse(env);

  if (!result.success) {
    throw new ConfigError(toIssues(result.error));
  }

  return result.data;
}

/**
 * Pure parse — throws ConfigError, never exits. Used directly by tests.
 */
export function parseConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);

  if (!result.success) {
    throw new ConfigError(toIssues(result.error));
  }

  return result.data;
}

/**
 * Startup entry point. A half-configured process is never allowed to start:
 * on any validation failure this writes the offending variables to stderr and
 * exits non-zero.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  try {
    return parseConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Startup entry point for database-only scripts. Same fail-fast contract as
 * `loadConfig`, but without demanding secrets the script does not use.
 */
export function loadDatabaseConfig(
  env: NodeJS.ProcessEnv = process.env,
): DatabaseConfig {
  try {
    return parseDatabaseConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}
