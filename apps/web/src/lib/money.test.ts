import { describe, expect, it } from 'vitest';
import { centsToDecimal, decimalToCents, todayInMalaysia } from './money';

describe('expense form money', () => {
  it('converts decimal strings without floating-point rounding', () => {
    expect(decimalToCents('149.30')).toBe(14930);
    expect(decimalToCents('-0.05')).toBe(-5);
    expect(centsToDecimal(14930)).toBe('149.30');
  });

  it('refuses more than two decimal places and malformed values', () => {
    expect(decimalToCents('1.001')).toBeUndefined();
    expect(decimalToCents('one')).toBeUndefined();
  });
});

describe('Malaysia today', () => {
  it('shifts UTC across the Malaysian calendar boundary', () => {
    expect(todayInMalaysia(Date.parse('2026-08-11T16:30:00.000Z'))).toBe('2026-08-12');
  });

  it('keeps the Malaysian date during its daytime', () => {
    expect(todayInMalaysia(Date.parse('2026-08-12T04:00:00.000Z'))).toBe('2026-08-12');
  });
});
