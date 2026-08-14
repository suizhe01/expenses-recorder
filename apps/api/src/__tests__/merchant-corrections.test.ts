import { describe, expect, it } from 'vitest';
import { normalizeMerchant } from '../routes/merchant-corrections.js';

describe('EXP-57 merchant correction matching', () => {
  it('AC-2: matches only after ignoring case, whitespace, and punctuation', () => {
    expect(normalizeMerchant('  PokeMist (Malaysia)  ')).toBe('pokemistmalaysia');
    expect(normalizeMerchant('POKEMIST---MALAYSIA')).toBe('pokemistmalaysia');
  });

  it('AC-2: does not turn a different merchant into a match', () => {
    expect(normalizeMerchant('Pokemist Malaysia')).not.toBe(normalizeMerchant('Pokebowl Malaysia'));
  });
});
