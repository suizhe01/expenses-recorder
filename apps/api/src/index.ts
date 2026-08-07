import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { ensureStorageReady } from './receipts/storage.js';

const config = loadConfig();
const database = createDatabase(config);
const app = buildApp({ config, database });

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await database.close();
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

// EXP-13 AC-16: prove the receipt store is usable before accepting traffic.
// Discovering an unwritable path on the first upload would mean losing a
// receipt the user believes was filed, so this fails fast instead — the same
// contract config validation already has.
try {
  await ensureStorageReady(config.RECEIPTS_PATH);
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
}

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error(error, 'failed to start');
  process.exit(1);
}
