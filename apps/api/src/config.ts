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
