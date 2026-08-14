import { describe, expect, it, vi } from 'vitest';
import type { ReceiptExtractor } from '../receipts/extraction.js';
import { createPaddleOcrAssistedExtractor } from '../receipts/paddleocr-extractor.js';
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

describe('PaddleOCR-assisted Gemini extractor', () => {
  it('EXP-58 AC-1 to AC-3: sends a visual-order OCR transcript to Gemini and records the hybrid source', async () => {
    const gemini = fallback();
    const laterLine = {
      ...line,
      text: 'MERCHANT',
      polygon: [{ x: 0, y: 30 }, { x: 100, y: 30 }, { x: 100, y: 50 }, { x: 0, y: 50 }] as PaddleOcrLine['polygon'],
    };
    const paddle: PaddleOcrClient = { read: vi.fn(async () => ({ lines: [laterLine, line] })) };
    const result = await createPaddleOcrAssistedExtractor(paddle, gemini).extract(image);

    expect(result).toMatchObject({
      status: 'succeeded', source: 'PaddleOCR-assisted Gemini', fields: { totalCents: 999 },
    });
    expect(gemini.extract).toHaveBeenCalledWith(image, {
      lines: [
        { text: 'TOTAL RM12.34', confidence: 0.99, polygon: line.polygon },
        { text: 'MERCHANT', confidence: 0.99, polygon: laterLine.polygon },
      ],
    });
  });

  it.each(['unavailable', 'timeout', 'non-success', 'malformed'])(
    'EXP-53 AC-4: uses Gemini when PaddleOCR is %s',
    async () => {
      const gemini = fallback();
      const paddle: PaddleOcrClient = { read: vi.fn(async () => null) };
      const result = await createPaddleOcrAssistedExtractor(paddle, gemini).extract(image);

      expect(result).toMatchObject({ status: 'succeeded', source: 'Gemini fallback' });
      expect(gemini.extract).toHaveBeenCalledWith(image);
    },
  );

  it('EXP-58 AC-5: keeps the deterministic local map when assisted Gemini fails', async () => {
    const paddle: PaddleOcrClient = { read: async () => ({ lines: [line] }) };
    const gemini: ReceiptExtractor = {
      model: 'gemini-test',
      extract: async () => ({ status: 'failed', error: 'fallback unavailable' }),
    };

    await expect(createPaddleOcrAssistedExtractor(paddle, gemini).extract(image)).resolves.toMatchObject({
      status: 'succeeded', source: 'PaddleOCR', fields: { totalCents: 1234, merchantTaxId: null },
    });
  });
});
