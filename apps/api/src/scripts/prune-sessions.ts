/**
 * Deletes session rows that can never authenticate again.
 *
 * Run by hand, or from the operator's own crontab. Nothing schedules it
 * (EXP-7 NG-1) — there is no timer in the API process and no admin endpoint.
 *
 *   npm run prune:sessions
 */
import { loadDatabaseConfig } from '../config.js';
import { createDatabase } from '../db.js';
import { pruneSessions, REVOKED_RETENTION_MS } from '../auth/sessions.js';

// Reuses the API's validated config schema, narrowed to the database subset,
// so a missing or malformed DATABASE_URL exits non-zero naming the variable
// rather than failing later on connect. Pruning has no business demanding
// JWT_SECRET from an operator's crontab.
const config = loadDatabaseConfig();
const database = createDatabase(config);

const retentionDays = Math.round(REVOKED_RETENTION_MS / (24 * 60 * 60 * 1_000));

try {
  const { expired, revoked } = await pruneSessions(database.pool);

  process.stdout.write(
    [
      `Deleted ${expired} expired session${expired === 1 ? '' : 's'}.`,
      `Deleted ${revoked} session${revoked === 1 ? '' : 's'} revoked more than ${retentionDays} days ago.`,
    ].join('\n') + '\n',
  );
} catch (error) {
  process.stderr.write(`Failed to prune sessions: ${String(error)}\n`);
  await database.close();
  process.exit(1);
}

await database.close();
