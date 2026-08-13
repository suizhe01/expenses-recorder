import { describe, expect, it, vi } from 'vitest';
import type { ReceiptExtractor } from '../receipts/extraction.js';
import { createPaddleOcrPrimaryExtractor } from '../receipts/paddleocr-extractor.js';
import type { PaddleOcrClient, PaddleOcrLine } from '../receipts/paddleocr.js';

const image = { bytes: Buffer.from('receipt'), contentType: 'image/jpeg' };
const line: PaddleOcrLine = {
  text: 'TOTAL RM12.34', confidence: 0.99,
  polygon: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 20 }, { x: 0, y: 20 }],
};

function fallback(): ReceiptExtractor {
  return {
    model: 'gemini-test',
    extract: vi.fn(async () => ({
      status: 'succeeded' as const,
      fields: {
        isReceipt: true, confidence: 1, merchantName: 'Gemini', merchantTaxId: null,
        receiptNumber: null, purchasedOn: null, purchasedAtTime: null, subtotalCents: null,
        taxCents: null, roundingCents: null, totalCents: 999, currency: 'MYR',
        paymentMethod: null, items: [],
      },
      promptTokens: 1, outputTokens: 1,
    })),
  };
}

describe('PaddleOCR primary extractor', () => {
  it('EXP-53 AC-2, AC-3: accepts partial local OCR without invoking Gemini', async () => {
    const gemini = fallback();
    const paddle: PaddleOcrClient = { read: vi.fn(async () => ({ lines: [line] })) };
    const result = await createPaddleOcrPrimaryExtractor(paddle, gemini).extract(image);

    expect(result).toMatchObject({
      status: 'succeeded', source: 'PaddleOCR', fields: { totalCents: 1234, merchantTaxId: null },
    });
    expect(gemini.extract).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'timeout', 'non-success', 'malformed'])(
    'EXP-53 AC-4: uses Gemini when PaddleOCR is %s',
    async () => {
      const gemini = fallback();
      const paddle: PaddleOcrClient = { read: vi.fn(async () => null) };
      const result = await createPaddleOcrPrimaryExtractor(paddle, gemini).extract(image);

      expect(result).toMatchObject({ status: 'succeeded', source: 'Gemini fallback' });
      expect(gemini.extract).toHaveBeenCalledWith(image);
    },
  );

  it('EXP-53 AC-5: preserves a failed Gemini fallback', async () => {
    const paddle: PaddleOcrClient = { read: async () => null };
    const gemini: ReceiptExtractor = {
      model: 'gemini-test',
      extract: async () => ({ status: 'failed', error: 'fallback unavailable' }),
    };

    await expect(createPaddleOcrPrimaryExtractor(paddle, gemini).extract(image)).resolves.toEqual({
      status: 'failed', error: 'fallback unavailable',
    });
  });
});
