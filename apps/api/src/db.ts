import pg from 'pg';
import type { Config } from './config.js';

const { Pool } = pg;

export type Database = {
  pool: pg.Pool;
  /** True when a trivial round-trip to Postgres succeeds. Never throws. */
  isReachable: () => Promise<boolean>;
  close: () => Promise<void>;
};

export function createDatabase(config: Config): Database {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    // Keep the health check honest: without a short timeout an unreachable
    // database leaves /health hanging instead of reporting degraded.
    connectionTimeoutMillis: 2_000,
    max: 10,
  });

  // A pool-level error (e.g. the database going away mid-connection) is
  // emitted on the pool itself. Without a listener Node treats it as an
  // unhandled 'error' event and kills the process.
  pool.on('error', () => {
    // Intentionally swallowed — /health reports the condition instead.
  });

  return {
    pool,
    async isReachable() {
      try {
        await pool.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      await pool.end();
    },
  };
}
