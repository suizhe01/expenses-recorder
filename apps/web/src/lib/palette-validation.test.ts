import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { categoryColor } from './palette';
import { validatePalette } from './palette-validation';

const tokenNames = ['cat-1', 'cat-2', 'cat-3', 'cat-4', 'cat-5', 'cat-6', 'cat-other'] as const;

async function paletteFor(selector: ':root' | '.dark') {
  const css = await readFile(resolve(process.cwd(), 'src/index.css'), 'utf8');
  const block = css.match(new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1];
  if (!block) throw new Error(`Could not find ${selector} palette tokens`);
  const tokens = Object.fromEntries(tokenNames.map((name) => {
    const value = block.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim();
    if (!value) throw new Error(`Could not find --${name} in ${selector}`);
    return [name, value];
  })) as Record<(typeof tokenNames)[number], string>;
  const surface = block.match(/--background:\s*([^;]+);/)?.[1]?.trim();
  if (!surface) throw new Error(`Could not find background in ${selector}`);
  return { surface, colors: tokenNames.slice(0, 6).map((name) => tokens[name]), other: tokens['cat-other'] };
}

describe('categorical palette', () => {
  it.each([':root', '.dark'] as const)('validates actual %s tokens against their own surface', async (selector) => {
    expect(validatePalette(await paletteFor(selector))).toMatchObject({
      passes: true,
      contrastPasses: true,
      chromaPasses: true,
      normalVisionPasses: true,
      cvdPasses: true,
    });
  });

  it('rejects a grey categorical hue instead of only checking the intended palette', async () => {
    const palette = await paletteFor(':root');
    palette.colors[2] = 'oklch(0.7 0 0)';
    expect(validatePalette(palette)).toMatchObject({ chromaPasses: false, passes: false });
  });

  it('rejects two chromatic slots that collapse under CVD simulation', async () => {
    const palette = await paletteFor(':root');
    palette.colors[2] = palette.colors[1]!;
    expect(validatePalette(palette)).toMatchObject({ chromaPasses: true, cvdPasses: false, passes: false });
  });
});

describe('categoryColor', () => {
  it('uses a fixed category slot and folds all out-of-range indexes into Other', () => {
    expect([0, 1, 2, 3, 4, 5].map(categoryColor)).toEqual([
      'var(--cat-1)', 'var(--cat-2)', 'var(--cat-3)', 'var(--cat-4)', 'var(--cat-5)', 'var(--cat-6)',
    ]);
    expect(categoryColor(6)).toBe('var(--cat-other)');
    expect(categoryColor(99)).toBe('var(--cat-other)');
  });
});
