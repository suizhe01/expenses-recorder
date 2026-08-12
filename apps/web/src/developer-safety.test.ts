import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('web developer safety', () => {
  it('EXP-36 AC-1, AC-5: keeps an overridable Malaysia timezone default in Vitest config', async () => {
    const source = await readFile(resolve(process.cwd(), 'vite.config.ts'), 'utf8');

    // Whitespace and quote style are deliberately irrelevant: this guards the
    // semantic default without making a harmless config reformat fail CI.
    expect(source).toMatch(/TZ\s*:\s*process\.env\.TZ\s*\?\?\s*['"]Asia\/Kuala_Lumpur['"]/);
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(
      process.env.TZ ?? 'Asia/Kuala_Lumpur',
    );
  });
});
