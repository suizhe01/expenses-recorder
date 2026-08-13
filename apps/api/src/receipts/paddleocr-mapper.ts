import { parseAmountToCents, type ExtractedFields, type ExtractedItem } from './extraction.js';
import type { PaddleOcrLine } from './paddleocr.js';

const TERMINAL_METADATA = /^(card name|terminal|site id|app crypt|auth ?code|verification|approved)\b/i;
const NON_ITEM_ROWS = /^(receipt(?: no)?|date|time|total|subtotal|rounding|payment|mydebit)\b/i;
const MERCHANT_EXCLUDED = /^(shell|receipt|date|time|fuel|total|mydebit)\b/i;

function left(line: PaddleOcrLine): number {
  return Math.min(...line.polygon.map((point) => point.x));
}

function cleaned(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function amount(text: string): number | null {
  const match = text.match(/(?:^|\s)(-?\s*(?:RM\s*)?\d[\d,]*\.\d{2})\s*$/i);
  return match ? parseAmountToCents(match[1]!.replace(/\s/g, '')) : null;
}

function description(text: string): { description: string; quantity: string | null } {
  const normalized = cleaned(text).replace(/\s+-?\s*(?:RM\s*)?\d[\d,]*\.\d{2}\s*$/i, '');
  const match = normalized.match(/^(\d+)\s+(.+)$/);
  return match ? { quantity: match[1]!, description: match[2]! } : { quantity: null, description: normalized };
}

function dateAndTime(lines: PaddleOcrLine[]): Pick<ExtractedFields, 'purchasedOn' | 'purchasedAtTime'> {
  const whole = lines.map((line) => line.text).join('\n');
  const date = whole.match(/\b(\d{2})(?:[/-]|\s?)(\d{2}|[A-Z]{3})(?:[/-]|\s?)(\d{4})\b/i);
  const time = whole.match(/\b(\d{1,2}):(\d{2})\s*(AM|PM)\b/i);
  if (!date) return { purchasedOn: null, purchasedAtTime: null };
  const monthValue = date[2]!.toUpperCase();
  const month = /^\d{2}$/.test(monthValue) ? Number(monthValue) :
    ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'].indexOf(monthValue) + 1;
  if (month < 1 || month > 12) return { purchasedOn: null, purchasedAtTime: null };
  let hour = time ? Number(time[1]) : 0;
  if (time?.[3]?.toUpperCase() === 'PM' && hour !== 12) hour += 12;
  if (time?.[3]?.toUpperCase() === 'AM' && hour === 12) hour = 0;
  return {
    purchasedOn: `${date[3]}-${String(month).padStart(2, '0')}-${date[1]}`,
    purchasedAtTime: time ? `${String(hour).padStart(2, '0')}:${time[2]}:00` : null,
  };
}

/** Maps static PaddleOCR lines only; it never calls a network service or guesses missing fields. */
export function mapPaddleOcrLines(input: PaddleOcrLine[]): ExtractedFields {
  const lines = [...input]
    .filter((line) => cleaned(line.text) !== '' && !TERMINAL_METADATA.test(cleaned(line.text)))
    .sort((a, b) => (Math.min(...a.polygon.map((p) => p.y)) - Math.min(...b.polygon.map((p) => p.y))) || left(a) - left(b));
  const dateTime = dateAndTime(lines);
  const merchant = lines.find((line) => /[A-Z]/i.test(line.text) && !MERCHANT_EXCLUDED.test(cleaned(line.text)));
  const receipt = lines.map((line) => cleaned(line.text)).find((line) => /receipt\s*(?:no)?\s*[:#]?\s*\w+/i.test(line));
  const receiptNumber = receipt?.match(/receipt\s*(?:no)?\s*[:#]?\s*([\w/-]+)/i)?.[1] ?? null;
  const totalLine = lines.find((line) => /^total\b/i.test(cleaned(line.text)));
  const items: ExtractedItem[] = [];
  let parentLeft: number | null = null;
  for (const line of lines) {
    if (NON_ITEM_ROWS.test(cleaned(line.text))) continue;
    const parsed = description(line.text);
    const cents = amount(line.text);
    if (!parsed.description) continue;
    const isComponent = items.length > 0 && parentLeft !== null && left(line) >= parentLeft + 12;
    if (isComponent) {
      items.at(-1)!.components.push({ ...parsed, unitPriceCents: null, lineTotalCents: cents });
    } else if (cents !== null) {
      items.push({ ...parsed, unitPriceCents: null, lineTotalCents: cents, components: [] });
      parentLeft = left(line);
    }
  }
  return {
    isReceipt: null, confidence: null, merchantName: merchant ? cleaned(merchant.text) : null,
    merchantTaxId: null, receiptNumber, ...dateTime, subtotalCents: null, taxCents: null,
    roundingCents: null, totalCents: totalLine ? amount(totalLine.text) : null,
    currency: lines.some((line) => /RM/i.test(line.text)) ? 'MYR' : null,
    paymentMethod: null, items,
  };
}
