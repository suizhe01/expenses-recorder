import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { mapPaddleOcrLines } from '../receipts/paddleocr-mapper.js';
import { createPaddleOcrClient, type PaddleOcrLine } from '../receipts/paddleocr.js';

async function fixture(name: string): Promise<PaddleOcrLine[]> {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as PaddleOcrLine[];
}

describe('PaddleOCR receipt mapper', () => {
  it('EXP-52 AC-5: maps Shell printed fields and keeps terminal rows out', async () => {
    const fields = mapPaddleOcrLines(await fixture('paddleocr-shell-lines.json'));
    expect(fields.merchantName).toBe('F ONE LYNAZFEA');
    expect(fields.purchasedOn).toBe('2026-08-11');
    expect(fields.purchasedAtTime).toBe('18:38:00');
    expect(fields.receiptNumber).toBe('872440');
    expect(fields.currency).toBe('MYR');
    expect(fields.totalCents).toBe(8849);
    expect(fields.items).toEqual([
      expect.objectContaining({ description: 'FuelSave 95(Pump 4)', lineTotalCents: 16765, components: [expect.objectContaining({ description: '44.470ltr@RM3.770/ltr' })] }),
      expect.objectContaining({ description: 'BUDI95 Subsidy', lineTotalCents: -7916, components: [expect.objectContaining({ description: '44.470ltr@RM1.780/ltr' })] }),
    ]);
  });

  it('EXP-52 AC-6: nests Pokemist options, including priced Add Rice', async () => {
    const fields = mapPaddleOcrLines(await fixture('paddleocr-pokemist-lines.json'));
    expect(fields.items).toHaveLength(3);
    expect(fields.items.every((item) => item.description === 'Cajun Chicken Thighs' && item.lineTotalCents === 1790)).toBe(true);
    expect(fields.items[1]!.components).toContainEqual(expect.objectContaining({ description: 'Add Rice', lineTotalCents: 100 }));
    expect(fields.items.some((item) => item.description === 'Add Rice')).toBe(false);
  });

  it('EXP-52 AC-3: an unavailable or malformed local service safely returns null', async () => {
    const client = createPaddleOcrClient('http://paddleocr:8008', async () => { throw new Error('offline'); });
    await expect(client.read({ bytes: Buffer.from('x'), contentType: 'image/jpeg' })).resolves.toBeNull();
  });
});
