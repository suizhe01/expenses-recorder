/**
 * EXP-15 — reading a receipt with Gemini.
 *
 * Shaped like `email/transport.ts` on purpose: an interface, a real
 * implementation, a fallback for when it is not configured, and injectability
 * so tests never reach the network (AC-15).
 *
 * Plain `fetch` rather than an SDK. The call is one POST, Node 22 has fetch
 * built in, and `AbortSignal.timeout` gives the exact 60-second bound AC-5
 * asks for. An SDK would also bring its own retry behaviour, which NG-3
 * forbids.
 */

/** AC-2. Every field is optional: a crumpled receipt may not show a tax number. */
export type ExtractedComponent = {
  description: string | null;
  quantity: string | null;
  unitPriceCents: number | null;
  lineTotalCents: number | null;
};

export type ExtractedItem = ExtractedComponent & {
  /** Components are deliberately one level deep; see RESPONSE_SCHEMA. */
  components: ExtractedComponent[];
};

export type ExtractedFields = {
  isReceipt: boolean | null;
  confidence: number | null;
  merchantName: string | null;
  merchantTaxId: string | null;
  receiptNumber: string | null;
  purchasedOn: string | null;
  purchasedAtTime: string | null;
  subtotalCents: number | null;
  taxCents: number | null;
  roundingCents: number | null;
  totalCents: number | null;
  currency: string | null;
  paymentMethod: string | null;
  items: ExtractedItem[];
};

/** The provider that produced a successful reading shown to the user. */
export type ExtractionSource = 'PaddleOCR' | 'Gemini fallback' | 'PaddleOCR-assisted Gemini';

export type ExtractionResult =
  | {
      status: 'succeeded';
      fields: ExtractedFields;
      promptTokens: number | null;
      outputTokens: number | null;
      /** Set by the primary/fallback coordinator, never by Gemini itself. */
      source?: ExtractionSource;
    }
  | { status: 'failed'; error: string }
  | { status: 'skipped' };

export type ReceiptImage = {
  bytes: Buffer;
  contentType: string;
};

/** Local OCR context is request-scoped and is never persisted with an extraction. */
export type OcrTranscript = {
  lines: {
    text: string;
    confidence: number;
    polygon: { x: number; y: number }[];
  }[];
};

export type ReceiptExtractor = {
  /** Recorded on every attempt row, so an old reading says what produced it. */
  readonly model: string;
  extract: (image: ReceiptImage, ocr?: OcrTranscript) => Promise<ExtractionResult>;
};

/**
 * AC-7. Used when no `GEMINI_API_KEY` is configured: makes no network call and
 * reports `skipped`, so an upload still succeeds and the attempt is on record.
 *
 * `skipped` rather than `failed` deliberately — otherwise every test run and
 * every keyless machine would look like Gemini was broken, and a real outage
 * would be lost in that noise.
 */
export function createSkippingExtractor(model: string): ReceiptExtractor {
  return {
    model,
    extract: async () => ({ status: 'skipped' }),
  };
}

/**
 * Amounts come back as they are printed — "12.35", "RM 1,234.50", "-0.02" —
 * and are converted here rather than by the model.
 *
 * Asking Gemini for integer cents would make it do arithmetic, which it gets
 * wrong more often than it misreads a number. Parsing a printed decimal is
 * deterministic and testable, and it keeps floats out of the money path
 * entirely (AC-3): the string is split on the decimal point and assembled with
 * integer maths.
 */
export function parseAmountToCents(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value * 100);
  }

  if (typeof value !== 'string') {
    return null;
  }

  const cleaned = value.replace(/[^0-9.,-]/g, '').replace(/,/g, '');

  if (cleaned === '' || !/^-?\d*\.?\d*$/.test(cleaned)) {
    return null;
  }

  const negative = cleaned.startsWith('-');
  const [whole = '0', fraction = ''] = cleaned.replace('-', '').split('.');

  if (whole === '' && fraction === '') {
    return null;
  }

  const cents =
    Number(whole || '0') * 100 + Number(fraction.padEnd(2, '0').slice(0, 2) || '0');

  return negative ? -cents : cents;
}

/**
 * Rates for `gemini-3.6-flash`, in micros (millionths of a dollar) per token,
 * as published in August 2026: $1.50 per million input tokens and $7.50 per
 * million output. These constants are tied to the `GEMINI_MODEL` default:
 * changing that model without changing these rates makes `cost_micros` wrong
 * for every subsequent attempt.
 *
 * The cost this produces is an estimate and nothing depends on it. Google's
 * prices change and an attempt row is historical, so the token counts stored
 * alongside it are the durable truth — if these constants drift, past rows stay
 * meaningful and only the convenience figure is stale.
 */
const INPUT_MICROS_PER_TOKEN = 1.5;
const OUTPUT_MICROS_PER_TOKEN = 7.5;

export function estimateCostMicros(
  promptTokens: number | null,
  outputTokens: number | null,
): number | null {
  if (promptTokens === null && outputTokens === null) {
    return null;
  }

  return Math.round(
    (promptTokens ?? 0) * INPUT_MICROS_PER_TOKEN +
      (outputTokens ?? 0) * OUTPUT_MICROS_PER_TOKEN,
  );
}

const PROMPT = [
  'You are reading a photograph of a retail receipt or tax invoice, most likely',
  'from Malaysia. Return only the fields defined by the response schema.',
  '',
  'Rules:',
  '- If the image is not a receipt or invoice at all, set isReceipt to false and',
  '  leave every other field null. Do not guess.',
  '- Report amounts exactly as printed, including the decimal point, without a',
  '  currency symbol. Do not convert, round, or recalculate them.',
  '- rounding is the "rounding adjustment" line many Malaysian receipts carry to',
  '  reach the nearest 5 sen. It is negative when the total was rounded down.',
  '- merchantTaxId is the SST, GST, or tax registration number if one is shown.',
  '- merchantName is the storefront, trading, or brand name shown most prominently',
  '  near the top of the receipt. Use a registered legal company name only when it',
  '  is the only merchant identity shown.',
  '- purchasedOn is the transaction date as YYYY-MM-DD. Malaysian receipts are',
  '  usually DD/MM/YYYY — read them that way, not as US month-first dates.',
  '- purchasedAtTime is 24-hour HH:MM:SS if a time is shown.',
  '- currency is the ISO code, MYR unless the receipt clearly says otherwise.',
  '- confidence is your overall confidence in this reading, 0 to 1.',
  '- Read line items from top to bottom. For each item, report description, quantity,',
  '  unitPrice, and lineTotal exactly as printed; do not recalculate amounts. Leave',
  '  any field the receipt does not show as null.',
  '- A modifier line qualifies, sizes, or adds to the item printed above it rather',
  '  than standing on its own. It may be indented, prefixed with a dash or bullet,',
  '  wrapped in parentheses, or printed with no amount; these are examples, not an',
  '  exhaustive list. Put modifier lines in the parent item\'s components array,',
  '  even when a modifier prints its own amount. An unpriced component has null',
  '  unitPrice and lineTotal; preserve amounts for a component exactly as printed.',
  '  Components never contain components.',
  '- A printed amount alone does not make a line a top-level item. When the receipt',
  '  prints an item count (for example "Item Count 2" or "3 SubTotal"), the number',
  '  of top-level items must match it; re-check the nesting if it does not.',
  '- Every top-level item must correspond to a line actually printed on the receipt.',
  '  Never invent an item with empty or null description, amounts, and components,',
  '  and never repeat an item that appears only once.',
  '- Leave any field null when the receipt does not show it. A missing value is',
  '  always better than an invented one.',
].join('\n');

/** The schema Gemini is constrained to (AC-12). Amounts are strings; see above. */
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    isReceipt: { type: 'BOOLEAN' },
    confidence: { type: 'NUMBER', nullable: true },
    merchantName: { type: 'STRING', nullable: true },
    merchantTaxId: { type: 'STRING', nullable: true },
    receiptNumber: { type: 'STRING', nullable: true },
    purchasedOn: { type: 'STRING', nullable: true },
    purchasedAtTime: { type: 'STRING', nullable: true },
    subtotal: { type: 'STRING', nullable: true },
    tax: { type: 'STRING', nullable: true },
    rounding: { type: 'STRING', nullable: true },
    total: { type: 'STRING', nullable: true },
    currency: { type: 'STRING', nullable: true },
    paymentMethod: { type: 'STRING', nullable: true },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          description: { type: 'STRING', nullable: true },
          quantity: { type: 'STRING', nullable: true },
          unitPrice: { type: 'STRING', nullable: true },
          lineTotal: { type: 'STRING', nullable: true },
          components: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                description: { type: 'STRING', nullable: true },
                quantity: { type: 'STRING', nullable: true },
                unitPrice: { type: 'STRING', nullable: true },
                lineTotal: { type: 'STRING', nullable: true },
              },
            },
          },
        },
      },
    },
  },
  required: ['isReceipt'],
} as const;

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/** AC-5. One bound on the whole call; there is no retry (NG-3). */
export const EXTRACTION_TIMEOUT_MS = 60_000;

function text(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  return trimmed === '' ? null : trimmed;
}

function extractedComponents(value: unknown): ExtractedComponent[] {
  if (!Array.isArray(value)) return [];

  return value.slice(0, 50).flatMap((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    return [{
      description: text(row.description),
      quantity: text(row.quantity),
      unitPriceCents: parseAmountToCents(row.unitPrice),
      lineTotalCents: parseAmountToCents(row.lineTotal),
    }];
  });
}

function extractedItems(value: unknown): ExtractedItem[] {
  if (!Array.isArray(value)) return [];

  return value.slice(0, 200).flatMap((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    return [{
      description: text(row.description),
      quantity: text(row.quantity),
      unitPriceCents: parseAmountToCents(row.unitPrice),
      lineTotalCents: parseAmountToCents(row.lineTotal),
      components: extractedComponents(row.components),
    }];
  });
}

/** Maps the model's JSON onto AC-2's fields, converting amounts to cents. */
export function toFields(payload: Record<string, unknown>): ExtractedFields {
  const isReceipt =
    typeof payload.isReceipt === 'boolean' ? payload.isReceipt : null;

  // AC-13: the model saying "not a receipt" is a correct answer, and nothing
  // it may have guessed alongside that is worth keeping.
  if (isReceipt === false) {
    return {
      isReceipt: false,
      confidence:
        typeof payload.confidence === 'number' ? payload.confidence : null,
      merchantName: null,
      merchantTaxId: null,
      receiptNumber: null,
      purchasedOn: null,
      purchasedAtTime: null,
      subtotalCents: null,
      taxCents: null,
      roundingCents: null,
      totalCents: null,
      currency: null,
      paymentMethod: null,
      items: [],
    };
  }

  return {
    isReceipt,
    confidence: typeof payload.confidence === 'number' ? payload.confidence : null,
    merchantName: text(payload.merchantName),
    merchantTaxId: text(payload.merchantTaxId),
    receiptNumber: text(payload.receiptNumber),
    purchasedOn: text(payload.purchasedOn),
    purchasedAtTime: text(payload.purchasedAtTime),
    subtotalCents: parseAmountToCents(payload.subtotal),
    taxCents: parseAmountToCents(payload.tax),
    roundingCents: parseAmountToCents(payload.rounding),
    totalCents: parseAmountToCents(payload.total),
    currency: text(payload.currency)?.toUpperCase() ?? null,
    paymentMethod: text(payload.paymentMethod),
    // A missing receipt verdict is not evidence that any accompanying rows are
    // real. Keep the same safe empty-array rule as an explicit false verdict.
    items: isReceipt === true ? extractedItems(payload.items) : [],
  };
}

export type GeminiExtractorOptions = {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /** Injectable only for tests; production uses the platform fetch implementation. */
  fetcher?: typeof fetch;
};

type GeminiResponse = {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string };
};

/**
 * AC-4, AC-6, AC-12. Every failure mode — a non-200, a refusal, output that
 * will not parse — returns `failed` with a reason rather than throwing, so the
 * caller can record it and still answer 201. Nothing here can cost a user their
 * receipt.
 */
export function createGeminiExtractor({
  apiKey,
  model,
  timeoutMs = EXTRACTION_TIMEOUT_MS,
  fetcher = fetch,
}: GeminiExtractorOptions): ReceiptExtractor {
  return {
    model,
    async extract({ bytes, contentType }: ReceiptImage, ocr?: OcrTranscript): Promise<ExtractionResult> {
      let response: Response;

      try {
        response = await fetcher(
          `${ENDPOINT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal: AbortSignal.timeout(timeoutMs),
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    {
                      text: ocr
                        ? `${PROMPT}\n\nPaddleOCR transcript follows. It is supplementary evidence only: use the image as the source of truth when text, order, or values disagree.\n${JSON.stringify(ocr)}`
                        : PROMPT,
                    },
                    {
                      inline_data: {
                        mime_type: contentType,
                        data: bytes.toString('base64'),
                      },
                    },
                  ],
                },
              ],
              generationConfig: {
                responseMimeType: 'application/json',
                responseSchema: RESPONSE_SCHEMA,
              },
            }),
          },
        );
      } catch (error) {
        // Includes the AbortError a timeout raises.
        return { status: 'failed', error: `request failed: ${String(error)}` };
      }

      let payload: GeminiResponse;

      try {
        payload = (await response.json()) as GeminiResponse;
      } catch (error) {
        return {
          status: 'failed',
          error: `response was not JSON (HTTP ${response.status}): ${String(error)}`,
        };
      }

      if (!response.ok) {
        return {
          status: 'failed',
          error: `HTTP ${response.status}: ${payload.error?.message ?? 'unknown error'}`,
        };
      }

      const body = payload.candidates?.[0]?.content?.parts?.[0]?.text;

      if (typeof body !== 'string') {
        // A refusal or a safety block lands here: 200, but no content.
        return {
          status: 'failed',
          error: `no content in response: ${JSON.stringify(payload).slice(0, 500)}`,
        };
      }

      let parsed: unknown;

      try {
        parsed = JSON.parse(body);
      } catch {
        // AC-12: the raw response is kept, and no partial row is written.
        return { status: 'failed', error: `model output was not JSON: ${body.slice(0, 500)}` };
      }

      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { status: 'failed', error: `model output was not an object: ${body.slice(0, 500)}` };
      }

      return {
        status: 'succeeded',
        fields: toFields(parsed as Record<string, unknown>),
        promptTokens: payload.usageMetadata?.promptTokenCount ?? null,
        outputTokens: payload.usageMetadata?.candidatesTokenCount ?? null,
      };
    },
  };
}
