/**
 * EXP-11 AC-7 — writes the OpenAPI document to `openapi.json`.
 *
 * The point of this script is that the document is obtainable without a running
 * server, a database, or any secret, so the Expo app can generate client types
 * in CI. Swagger UI at `/docs` is development-only (AC-2), and would be no use
 * in a pipeline anyway.
 *
 *   npm run openapi
 */
import { writeFile } from 'node:fs/promises';
import { buildApp } from '../app.js';
import { parseConfig } from '../config.js';
import { createDatabase } from '../db.js';

const OUTPUT = new URL('../../openapi.json', import.meta.url);

// Placeholders for the variables the app validates at construction. Nothing
// here connects or signs anything: the routes are only registered so Fastify
// can describe them. Real values from the environment still win, so running
// this on a configured machine changes nothing about the output.
const config = parseConfig({
  DATABASE_URL: 'postgres://openapi:openapi@localhost:5432/openapi',
  JWT_SECRET: 'openapi-generation-secret-not-used-to-sign-anything',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  LOG_LEVEL: 'silent',
  ...process.env,
});

const database = createDatabase(config);
const app = buildApp({ config, database });

try {
  await app.ready();

  const document = app.swagger();

  await writeFile(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);

  const paths = Object.keys((document as { paths?: object }).paths ?? {}).length;
  process.stdout.write(`Wrote ${paths} paths to openapi.json\n`);
} catch (error) {
  process.stderr.write(`Failed to write openapi.json: ${String(error)}\n`);
  await app.close();
  await database.close();
  process.exit(1);
}

await app.close();
await database.close();
