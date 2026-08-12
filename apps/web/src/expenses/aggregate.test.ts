import { describe, expect, it } from 'vitest';
import type { Expense } from '@/api/expenses';
import { overviewFor, previousMonth } from './aggregate';

const rows: Expense[] = [
  { id: '1', category: { id: 'food', name: 'Food' }, receiptId: null, totalCents: 1200, purchasedOn: '2026-08-01', currency: 'MYR', merchantName: null, receiptNumber: null, note: null },
  { id: '2', category: { id: 'food', name: 'Food' }, receiptId: null, totalCents: 800, purchasedOn: '2026-08-02', currency: 'MYR', merchantName: null, receiptNumber: null, note: null },
  { id: '3', category: { id: 'travel', name: 'Travel' }, receiptId: null, totalCents: 1000, purchasedOn: '2026-07-31', currency: 'MYR', merchantName: null, receiptNumber: null, note: null },
  { id: '4', category: { id: 'food', name: 'Food' }, receiptId: null, totalCents: 9999, purchasedOn: '2026-08-01', currency: 'SGD', merchantName: null, receiptNumber: null, note: null },
];
describe('overview aggregation', () => {
  it('uses YYYY-MM-DD strings, keeps currencies separate, and derives every figure', () => {
    const result = overviewFor(rows, '2026-08', 'MYR')!;
    expect(result).toMatchObject({ totalCents: 2000, previousTotalCents: 1000, percentChange: 100, averageMonthlyCents: 1500, busiestDay: 'Saturday', currencies: ['MYR', 'SGD'] });
    expect(result.categories).toEqual([{ name: 'Food', count: 2, totalCents: 2000 }]);
    expect(previousMonth('2026-01')).toBe('2025-12');
  });
  it('does not produce a percentage when the previous month has no spending', () => expect(overviewFor(rows.filter((row) => row.purchasedOn !== '2026-07-31'), '2026-08', 'MYR')!.percentChange).toBeUndefined());
});
