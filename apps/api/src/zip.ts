/**
 * EXP-21. Entry naming for the receipt ZIP export.
 *
 * Deliberately NOT under `src/routes/`, for the same reason `csv.ts` and
 * `validation.ts` are not: the OpenAPI test greps that directory for `body:`,
 * `querystring:` and `params:` at the start of a line, and it should keep
 * scanning route files only.
 */

/**
 * AC-6. The stored `content_type` decides the extension, because the files on
 * disk are named by content hash and carry none.
 *
 * The four keys are exactly `ACCEPTED_TYPES` from `receipts/storage.ts`, which
 * is enforced by magic-byte sniffing at upload, so the fallback below is
 * unreachable from an HTTP request. It exists so a row written by some future
 * path cannot produce `....undefined` as a filename.
 */
export const EXTENSION_FOR: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

const FALLBACK_EXTENSION = 'bin';

/** AC-7. Path separators and the Windows-reserved set. */
const FORBIDDEN = /[/\\:*?"<>|]/g;

/** AC-7. Whitespace runs become a single hyphen. */
const WHITESPACE = /\s+/g;

/** Single-character form of the above. Non-global, so it carries no `lastIndex`. */
const IS_WHITESPACE = /\s/;

/** AC-7. Leading and trailing dots and spaces — a name may not start or end with either. */
const EDGE_DOTS_AND_SPACES = /^[.\s]+|[.\s]+$/g;

/** AC-7. After truncation the tail may be a separator, which would read as an accident. */
const EDGE_SEPARATORS = /^[-.\s]+|[-.\s]+$/g;

const MERCHANT_MAX = 60;

/** AC-7. What an unnamed, or entirely unprintable, merchant becomes. */
export const UNKNOWN_MERCHANT = 'unknown';

/**
 * Removes C0 controls and DEL without a control-character regex.
 *
 * **Whitespace is kept even though tab, newline and carriage return are C0
 * controls.** They are separators the writer meant, so they belong to the
 * whitespace rule below and become a hyphen; deleting them first turned
 * `Master Prawn\tMee` into `Master-PrawnMee`, welding two words together.
 * Genuinely unprintable bytes have no such meaning and go.
 *
 * Spreading iterates by code point rather than UTF-16 unit, so an astral
 * character — an emoji in a merchant name — is never split into a lone
 * surrogate, which is what a naive `split('')` would do.
 */
function stripControlCharacters(value: string): string {
  return [...value]
    .filter((character) => {
      if (IS_WHITESPACE.test(character)) {
        return true;
      }

      const code = character.codePointAt(0) as number;

      return code > 0x1f && code !== 0x7f;
    })
    .join('');
}

/**
 * AC-7. The merchant part of an entry name.
 *
 * **Unicode is kept on purpose.** An ASCII-only slug would reduce `皇帝虾面` to
 * nothing and then to `unknown`, and in this archive a Chinese merchant name is
 * an ordinary case rather than an exotic one. ZIP carries a UTF-8 filename flag
 * and every extractor in use honours it.
 *
 * Truncation happens after the substitutions, so the 60 characters are 60
 * characters of the name that will actually be written.
 */
export function merchantSegment(merchantName: string | null): string {
  if (merchantName === null) {
    return UNKNOWN_MERCHANT;
  }

  const cleaned = stripControlCharacters(merchantName)
    .replace(FORBIDDEN, '')
    .replace(EDGE_DOTS_AND_SPACES, '')
    .replace(WHITESPACE, '-')
    .slice(0, MERCHANT_MAX)
    .replace(EDGE_SEPARATORS, '');

  // A name of only stripped characters — `"???"`, or pure whitespace — lands
  // here, and is as nameless as a null one.
  return cleaned === '' ? UNKNOWN_MERCHANT : cleaned;
}

/** The folder every image lives under, so the CSV sits alone at the root. */
export const RECEIPTS_PREFIX = 'receipts/';

/**
 * AC-6. `receipts/<purchase date>_<merchant>_<first 8 of the receipt id>.<ext>`.
 *
 * Date first so a file listing sorts chronologically; the id last so the entry
 * can be matched back to the CSV's `Receipt ID` column, and so two receipts from
 * the same merchant on the same day are still distinguishable.
 */
export function entryName(receipt: {
  purchasedOn: string;
  merchantName: string | null;
  receiptId: string;
  contentType: string;
}): string {
  const extension = EXTENSION_FOR[receipt.contentType] ?? FALLBACK_EXTENSION;
  const merchant = merchantSegment(receipt.merchantName);

  return `${RECEIPTS_PREFIX}${receipt.purchasedOn}_${merchant}_${receipt.receiptId.slice(0, 8)}.${extension}`;
}

/**
 * AC-9. Claims `name`, or the first free `-2`, `-3`… variant, recording it in
 * `used`.
 *
 * A ZIP with two identical entry names is legal to write and a mess to extract:
 * most tools silently overwrite the first with the second, so one receipt would
 * vanish. Eight hex characters of a uuid collide about 5% of the time across
 * 20,000 entries, and the date and merchant have to match too — rare, but not
 * rare enough to leave to chance in a tax record.
 */
export function uniqueEntryName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);

    return name;
  }

  const dot = name.lastIndexOf('.');
  const stem = name.slice(0, dot);
  const extension = name.slice(dot);

  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${stem}-${suffix}${extension}`;

    if (!used.has(candidate)) {
      used.add(candidate);

      return candidate;
    }
  }
}
