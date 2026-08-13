import { readFileSync } from 'node:fs';

const files = {
  config: readFileSync('apps/api/src/config.ts', 'utf8'),
  compose: readFileSync('docker-compose.yml', 'utf8'),
  envExample: readFileSync('.env.example', 'utf8'),
};

const defaults = {
  config: files.config.match(/GEMINI_MODEL: z\.string\(\)\.min\(1\)\.default\('([^']+)'\)/)?.[1],
  compose: files.compose.match(/GEMINI_MODEL: \$\{GEMINI_MODEL:-([^}]+)\}/)?.[1],
  envExample: files.envExample.match(/^GEMINI_MODEL=(.+)$/m)?.[1],
};

if (!defaults.config || !defaults.compose || !defaults.envExample) {
  throw new Error('Could not read every GEMINI_MODEL default.');
}

if (new Set(Object.values(defaults)).size !== 1) {
  throw new Error(`GEMINI_MODEL defaults drifted: ${JSON.stringify(defaults)}`);
}

console.log(`GEMINI_MODEL defaults agree on ${defaults.config}.`);
