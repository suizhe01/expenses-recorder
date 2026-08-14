import type { OcrTranscript, ReceiptImage } from './extraction.js';

export type OcrPoint = { x: number; y: number };

export type PaddleOcrLine = {
  text: string;
  polygon: [OcrPoint, OcrPoint, OcrPoint, OcrPoint];
  confidence: number;
};

export type PaddleOcrResponse = { lines: PaddleOcrLine[] };

export type PaddleOcrClient = {
  read: (image: ReceiptImage) => Promise<PaddleOcrResponse | null>;
};

/** Stable visual reading order for Gemini context: top-to-bottom, then left-to-right. */
export function toOcrTranscript(lines: PaddleOcrLine[]): OcrTranscript {
  return {
    lines: [...lines]
      .sort((a, b) => {
        const topDifference = Math.min(...a.polygon.map((point) => point.y))
          - Math.min(...b.polygon.map((point) => point.y));
        if (topDifference !== 0) return topDifference;
        return Math.min(...a.polygon.map((point) => point.x))
          - Math.min(...b.polygon.map((point) => point.x));
      })
      .map(({ text, confidence, polygon }) => ({ text, confidence, polygon })),
  };
}

type Fetch = typeof fetch;

const DEFAULT_TIMEOUT_MS = 5_000;

function point(value: unknown): value is OcrPoint {
  return value !== null && typeof value === 'object' &&
    typeof (value as Record<string, unknown>).x === 'number' &&
    typeof (value as Record<string, unknown>).y === 'number';
}

function response(value: unknown): PaddleOcrResponse | null {
  if (value === null || typeof value !== 'object' || !Array.isArray((value as { lines?: unknown }).lines)) {
    return null;
  }

  const lines = (value as { lines: unknown[] }).lines;
  if (!lines.every((line) => {
    if (line === null || typeof line !== 'object') return false;
    const row = line as Record<string, unknown>;
    return typeof row.text === 'string' && typeof row.confidence === 'number' &&
      Number.isFinite(row.confidence) && Array.isArray(row.polygon) &&
      row.polygon.length === 4 && row.polygon.every(point);
  })) return null;

  return { lines: lines as PaddleOcrLine[] };
}

/**
 * Creates an internal, opt-in reader. Every transport or payload problem is a
 * null result, so future callers can observe OCR without endangering uploads.
 */
export function createPaddleOcrClient(
  baseUrl: string,
  fetcher: Fetch = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): PaddleOcrClient {
  return {
    read: async (image) => {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(image.contentType)) return null;

      const form = new FormData();
      form.set('image', new Blob([new Uint8Array(image.bytes)], { type: image.contentType }), 'receipt');

      try {
        const result = await fetcher(new URL('/ocr', baseUrl), {
          method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs),
        });
        if (!result.ok) return null;
        return response(await result.json());
      } catch {
        return null;
      }
    },
  };
}
