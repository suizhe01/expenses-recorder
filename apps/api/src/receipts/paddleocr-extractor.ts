import type {
  ExtractionResult,
  ReceiptExtractor,
  ReceiptImage,
} from './extraction.js';
import type { PaddleOcrClient } from './paddleocr.js';
import { toOcrTranscript } from './paddleocr.js';
import { mapPaddleOcrLines } from './paddleocr-mapper.js';

/**
 * Gives Gemini the original image plus local OCR as supplementary context.
 * Gemini remains the image-based source of truth. If it cannot return a valid
 * reading after OCR succeeds, the deterministic local mapping is kept instead.
 */
export function createPaddleOcrAssistedExtractor(
  paddleOcr: PaddleOcrClient,
  fallback: ReceiptExtractor,
): ReceiptExtractor {
  return {
    model: 'PaddleOCR-assisted Gemini',
    async extract(image: ReceiptImage): Promise<ExtractionResult> {
      const reading = await paddleOcr.read(image);

      if (reading) {
        const result = await fallback.extract(image, toOcrTranscript(reading.lines));
        if (result.status === 'succeeded') {
          return { ...result, source: 'PaddleOCR-assisted Gemini' };
        }
        return {
          status: 'succeeded',
          fields: mapPaddleOcrLines(reading.lines),
          promptTokens: null,
          outputTokens: null,
          source: 'PaddleOCR',
        };
      }

      const result = await fallback.extract(image);
      return result.status === 'succeeded'
        ? { ...result, source: 'Gemini fallback' }
        : result;
    },
  };
}
