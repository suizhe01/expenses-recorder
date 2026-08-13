import { categoryIcon, FALLBACK_CATEGORY_ICON } from '@/lib/category-icon';

/** The nine names migration 0006 seeds for every new account. */
const DEFAULTS = [
  'Food',
  'Groceries',
  'Transport',
  'Medical',
  'Education',
  'Utilities',
  'Shopping',
  'Entertainment',
  'Other',
];

describe('category icon', () => {
  // Lucide icons are forwardRef objects, not plain functions — assert they are
  // renderable components rather than pinning their internal shape.
  it('gives every seeded default an icon', () => {
    for (const name of DEFAULTS) {
      expect(categoryIcon(name)).toBeTruthy();
    }
  });

  /**
   * `Other` is deliberately the fallback rather than a bespoke glyph — it is a
   * catch-all, so the neutral tag is the honest drawing of it.
   */
  it('resolves Other to the neutral fallback', () => {
    expect(categoryIcon('Other')).toBe(FALLBACK_CATEGORY_ICON);
  });

  it('matches regardless of case and surrounding space', () => {
    expect(categoryIcon(' FOOD ')).toBe(categoryIcon('Food'));
    expect(categoryIcon('groceries')).toBe(categoryIcon('Groceries'));
  });

  it('falls back for an unknown name instead of throwing', () => {
    expect(categoryIcon('Pet grooming')).toBe(FALLBACK_CATEGORY_ICON);
    expect(categoryIcon('')).toBe(FALLBACK_CATEGORY_ICON);
  });

  /**
   * The eight known defaults must not all collapse onto the fallback — that is
   * how this map would silently become decoration-free while still passing a
   * "has an icon" check.
   */
  it('distinguishes the known defaults from the fallback', () => {
    const known = DEFAULTS.filter((name) => name !== 'Other');
    for (const name of known) {
      expect(categoryIcon(name)).not.toBe(FALLBACK_CATEGORY_ICON);
    }
    expect(new Set(known.map((name) => categoryIcon(name))).size).toBe(known.length);
  });
});
