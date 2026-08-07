import type { Executor } from '../auth/sessions.js';
import {
  estimateCostMicros,
  type ExtractionResult,
} from './extraction.js';

export type ExtractionStatus = 'succeeded' | 'failed' | 'skipped';

export type ExtractionRow = {
  id: string;
  receipt_id: string;
  status: ExtractionStatus;
  model: string;
  is_receipt: boolean | null;
  confidence: string | null;
  merchant_name: string | null;
  merchant_tax_id: string | null;
  receipt_number: string | null;
  purchased_on: Date | null;
  purchased_at_time: string | null;
  subtotal_cents: number | null;
  tax_cents: number | null;
  rounding_cents: number | null;
  total_cents: number | null;
  currency: string | null;
  payment_method: string | null;
  created_at: Date;
};

/**
 * AC-9. What the API is allowed to show.
 *
 * `prompt_tokens`, `output_tokens` and `cost_micros` are deliberately absent
 * from this type as well as from the SELECT below, so exposing them would take
 * a deliberate edit in two places rather than a careless spread of a row.
 */
export type Extraction = {
  status: ExtractionStatus;
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
  extractedAt: string;
};

export function toExtraction(row: ExtractionRow): Extraction {
  return {
    status: row.status,
    isReceipt: row.is_receipt,
    // numeric comes back as a string from pg to avoid float loss.
    confidence: row.confidence === null ? null : Number(row.confidence),
    merchantName: row.merchant_name,
    merchantTaxId: row.merchant_tax_id,
    receiptNumber: row.receipt_number,
    purchasedOn:
      row.purchased_on === null
        ? null
        : row.purchased_on.toISOString().slice(0, 10),
    purchasedAtTime: row.purchased_at_time,
    subtotalCents: row.subtotal_cents,
    taxCents: row.tax_cents,
    roundingCents: row.rounding_cents,
    totalCents: row.total_cents,
    currency: row.currency,
    paymentMethod: row.payment_method,
    extractedAt: row.created_at.toISOString(),
  };
}

/** Everything the API may return. Never selects tokens or cost (AC-9). */
const PUBLIC_COLUMNS = `id, receipt_id, status, model, is_receipt, confidence,
  merchant_name, merchant_tax_id, receipt_number, purchased_on,
  purchased_at_time, subtotal_cents, tax_cents, rounding_cents, total_cents,
  currency, payment_method, created_at`;

/**
 * AC-10. Inserts an attempt. Never updates: a re-run adds a row, so the first
 * reading of a receipt stays on record.
 */
export async function recordExtraction(
  executor: Executor,
  receiptId: string,
  model: string,
  result: ExtractionResult,
): Promise<ExtractionRow> {
  const fields = result.status === 'succeeded' ? result.fields : null;
  const promptTokens = result.status === 'succeeded' ? result.promptTokens : null;
  const outputTokens = result.status === 'succeeded' ? result.outputTokens : null;

  const { rows } = await executor.query<ExtractionRow>(
    `INSERT INTO receipt_extractions (
       receipt_id, status, model, prompt_tokens, output_tokens, cost_micros,
       error, is_receipt, confidence, merchant_name, merchant_tax_id,
       receipt_number, purchased_on, purchased_at_time, subtotal_cents,
       tax_cents, rounding_cents, total_cents, currency, payment_method
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             $16, $17, $18, $19, $20)
     RETURNING ${PUBLIC_COLUMNS}`,
    [
      receiptId,
      result.status,
      model,
      promptTokens,
      outputTokens,
      estimateCostMicros(promptTokens, outputTokens),
      result.status === 'failed' ? result.error : null,
      fields?.isReceipt ?? null,
      fields?.confidence ?? null,
      fields?.merchantName ?? null,
      fields?.merchantTaxId ?? null,
      fields?.receiptNumber ?? null,
      fields?.purchasedOn ?? null,
      fields?.purchasedAtTime ?? null,
      fields?.subtotalCents ?? null,
      fields?.taxCents ?? null,
      fields?.roundingCents ?? null,
      fields?.totalCents ?? null,
      fields?.currency ?? null,
      fields?.paymentMethod ?? null,
    ],
  );

  return rows[0] as ExtractionRow;
}

/** AC-9. The newest attempt for each of the given receipts. */
export async function latestExtractionsFor(
  executor: Executor,
  receiptIds: string[],
): Promise<Map<string, ExtractionRow>> {
  if (receiptIds.length === 0) {
    return new Map();
  }

  const { rows } = await executor.query<ExtractionRow>(
    `SELECT DISTINCT ON (receipt_id) ${PUBLIC_COLUMNS}
     FROM receipt_extractions
     WHERE receipt_id = ANY($1::uuid[])
     ORDER BY receipt_id, created_at DESC, id DESC`,
    [receiptIds],
  );

  return new Map(rows.map((row) => [row.receipt_id, row]));
}
