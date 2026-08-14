import { describe, expect, it } from 'vitest';
import { createGeminiExtractor } from '../receipts/extraction.js';

const image = { bytes: Buffer.from('original-receipt'), contentType: 'image/jpeg' };

describe('Gemini OCR context', () => {
  it('EXP-58 AC-1 and AC-2: sends the original image and structured PaddleOCR evidence together', async () => {
    let requestBody = '';
    const fetcher: typeof fetch = async (_input, init) => {
      requestBody = String(init?.body);
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"isReceipt":true}' }] } }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3 },
      }), { status: 200 });
    };
    const extractor = createGeminiExtractor({
      apiKey: 'test-key', model: 'gemini-test', fetcher,
    });

    await expect(extractor.extract(image, {
      lines: [{
        text: 'TOTAL RM12.34', confidence: 0.99,
        polygon: [{ x: 0, y: 20 }, { x: 80, y: 20 }, { x: 80, y: 40 }, { x: 0, y: 40 }],
      }],
    })).resolves.toMatchObject({ status: 'succeeded', fields: { isReceipt: true } });

    const request = JSON.parse(requestBody);
    const parts = request.contents[0].parts;
    expect(parts[0].text).toContain('PaddleOCR transcript follows');
    expect(parts[0].text).toContain('TOTAL RM12.34');
    expect(parts[0].text).toContain('"confidence":0.99');
    expect(parts[0].text).toContain('"x":0');
    expect(parts[1]).toEqual({
      inline_data: { mime_type: 'image/jpeg', data: image.bytes.toString('base64') },
    });
  });
});
