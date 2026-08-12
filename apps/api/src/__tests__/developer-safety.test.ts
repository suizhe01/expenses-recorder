import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { selectEmailTransport } from '../app.js';
import { parseConfig } from '../config.js';

const base = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/expenses',
  JWT_SECRET: 'a'.repeat(32),
  PUBLIC_BASE_URL: 'http://localhost:3000',
  LOG_LEVEL: 'silent',
};

describe('developer safety', () => {
  it('uses console mail in test mode even when a Resend key is present', () => {
    const transport = selectEmailTransport(parseConfig({
      ...base,
      NODE_ENV: 'test',
      RESEND_API_KEY: 're_real_key_must_not_be_used',
    }), { info: () => undefined });

    expect(transport.name).toBe('console');
  });

  it('uses the environment timezone while retaining the Malaysia default', async () => {
    const source = await readFile(new URL('../../vitest.config.ts', import.meta.url), 'utf8');
    expect(source).toContain("process.env.TZ ?? 'Asia/Kuala_Lumpur'");
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(
      process.env.TZ ?? 'Asia/Kuala_Lumpur',
    );
  });
});
