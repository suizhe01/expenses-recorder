import type {
  ExtractionResult,
  ReceiptExtractor,
  ReceiptImage,
} from './extraction.js';
import type { PaddleOcrClient } from './paddleocr.js';
import { mapPaddleOcrLines } from './paddleocr-mapper.js';

/**
 * Uses local OCR as a complete, deterministic reading. A well-formed OCR
 * response is success even when some fields are blank: Gemini must not fill
 * those blanks. Only an unavailable, failed, or malformed OCR response falls
 * through to Gemini.
 */
export function createPaddleOcrPrimaryExtractor(
  paddleOcr: PaddleOcrClient,
  fallback: ReceiptExtractor,
): ReceiptExtractor {
  return {
    model: 'PaddleOCR / Gemini fallback',
    async extract(image: ReceiptImage): Promise<ExtractionResult> {
      const reading = await paddleOcr.read(image);

      if (reading) {
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
