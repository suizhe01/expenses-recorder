import { describe, expect, it } from 'vitest';
import { compareExtraction, type ExpectedExtraction } from '../eval/extraction-eval.js';

const expected: ExpectedExtraction = {
  isReceipt: true, merchantName: 'Cafe', merchantTaxId: null, receiptNumber: null,
  purchasedOn: '2026-08-08', purchasedAtTime: null, subtotalCents: 1200, taxCents: null,
  roundingCents: null, totalCents: 1200, currency: 'MYR', paymentMethod: null,
  items: [{ description: 'Noodles', quantity: '1', unitPriceCents: null, lineTotalCents: 1200, components: [{ description: 'Egg', quantity: '1', unitPriceCents: null, lineTotalCents: 100 }] }],
};

describe('extraction eval comparison', () => {
  it('reports a wrong item count and nested component amount as readable differences', () => {
    const actual = { ...expected, confidence: 0.9, items: [{ ...expected.items[0]!, components: [{ ...expected.items[0]!.components[0]!, lineTotalCents: 50 }] }, { description: 'Extra', quantity: null, unitPriceCents: null, lineTotalCents: null, components: [] }] };
    expect(compareExtraction(expected, actual)).toEqual([
      { path: 'items.length', expected: 1, actual: 2 },
      { path: 'items[0].components[0].lineTotalCents', expected: 100, actual: 50 },
    ]);
  });

  it('has no differences for equal observable fields regardless of confidence', () => {
    expect(compareExtraction(expected, { ...expected, confidence: 0.01 })).toEqual([]);
  });
});
