/**
 * EXP-20. RFC 4180 CSV primitives for the expense export.
 *
 * Deliberately NOT under `src/routes/`, for the same reason `validation.ts` is
 * not: the OpenAPI test greps that directory for `body:`, `querystring:` and
 * `params:` at the start of a line, and it should keep scanning route files
 * only.
 *
 * Nothing here knows what an expense is. The route owns the column order; this
 * module owns how a value becomes a cell.
 */

/**
 * AC-8. Excel decides a CSV's encoding by sniffing, and without this it reads
 * UTF-8 as the platform's legacy code page — `皇帝虾面` arrives as `ç‡å¸è¾é¢`.
 * Every other consumer tried (Numbers, Sheets, LibreOffice, pandas) strips it.
 */
export const BOM = '﻿';

/** AC-9. RFC 4180 says CRLF, and it is what Excel expects on every platform. */
const RECORD_SEPARATOR = '\r\n';

/**
 * AC-10. A cell starting with any of these is evaluated as a formula when the
 * file is opened, so `=HYPERLINK(...)` in a merchant name becomes a live link
 * in someone's spreadsheet. TAB and CR are here because Excel strips leading
 * whitespace before deciding, so `\t=cmd` is `=cmd`.
 */
const FORMULA_LEADERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/** Malaysia is UTC+8 year round; there is no daylight saving to track. */
const MALAYSIA_OFFSET_MS = 8 * 60 * 60 * 1000;

function quote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** AC-9. Only these four characters make a bare value ambiguous. */
function needsQuoting(value: string): boolean {
  return /["\n\r,]/.test(value);
}

/**
 * AC-6, AC-9, AC-10. A cell holding text the user supplied.
 *
 * This is the only cell type that carries the formula guard, and that split is
 * the point: applying it everywhere would turn `-0.02` in the Rounding column
 * into the text `'-0.02`, which no longer sums. A guarded value is always
 * quoted as well as prefixed, so the apostrophe cannot itself be misread.
 */
export function textCell(value: string | null): string {
  if (value === null || value === '') {
    return '';
  }

  if (FORMULA_LEADERS.has(value[0] as string)) {
    return quote(`'${value}`);
  }

  return needsQuoting(value) ? quote(value) : value;
}

/**
 * AC-6, AC-9. A cell this codebase generated — an id, a date, a formatted
 * amount. Quoted when it has to be, never formula-guarded.
 */
export function plainCell(value: string | null): string {
  if (value === null) {
    return '';
  }

  return needsQuoting(value) ? quote(value) : value;
}

/**
 * AC-5. Integer cents to a two-decimal string: `14930` → `149.30`, `5` →
 * `0.05`, `-2` → `-0.02`, `0` → `0.00`. Null stays an empty cell (AC-6).
 *
 * Built from integer arithmetic rather than `(cents / 100).toFixed(2)` because
 * that route goes through a float, and the sign is applied last so `-2` cannot
 * render as `-0.-2`.
 */
export function centsCell(cents: number | null): string {
  if (cents === null) {
    return '';
  }

  const absolute = Math.abs(cents);
  const whole = Math.trunc(absolute / 100);
  const fraction = (absolute % 100).toString().padStart(2, '0');

  return `${cents < 0 ? '-' : ''}${whole}.${fraction}`;
}

/**
 * AC-7. A `timestamptz` rendered as `YYYY-MM-DD HH:MM:SS` in Malaysian time.
 *
 * Shifting the instant and then reading it back through `toISOString` — which
 * is always UTC — is what keeps the process timezone out of the answer. The
 * obvious `toLocaleString` alternative reads `TZ`, so the same row would export
 * differently from the container (pinned UTC) and from the test suite (pinned
 * Asia/Kuala_Lumpur), and CI would disagree with production about what a
 * receipt's timestamp says.
 *
 * The same lesson as EXP-17's `to_char`, one layer up: a date-like value must
 * never acquire a timezone by accident.
 */
export function timestampCell(at: Date): string {
  return new Date(at.getTime() + MALAYSIA_OFFSET_MS)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
}

/** AC-9. One CSV record, terminated. */
export function csvRow(cells: string[]): string {
  return cells.join(',') + RECORD_SEPARATOR;
}
