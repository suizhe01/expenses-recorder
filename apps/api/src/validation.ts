import type { z } from 'zod';

/**
 * EXP-19. The one place a zod error becomes the `fields` object of a 400.
 *
 * Extracted from three byte-identical copies in `routes/categories.ts`,
 * `routes/expenses.ts` and `routes/auth.ts`. That duplication was why a
 * one-line bug would otherwise need fixing in three places, and copies drift.
 *
 * Deliberately NOT under `src/routes/`: the OpenAPI test greps that directory
 * for `body:`, `querystring:` and `params:` at the start of a line, and it
 * should keep scanning route files only.
 */

/** AC-7. An issue with no path is about the payload as a whole, not a field. */
const WHOLE_BODY = 'body';
const NOT_AN_OBJECT = 'must be a JSON object';

/** AC-6. Accurate wording because only a query schema is strict (NG-1). */
const UNRECOGNISED = 'is not a recognised query parameter';

/**
 * AC-2, AC-6, AC-7. One message per field, keyed by the field it concerns.
 *
 * **The first issue for a path wins, not the last.** zod appends issues in check
 * order and keeps going after one fails — the result is *dirty*, not aborted —
 * so a single field accumulates several, and the earliest is the most specific.
 * `from=yesterday` produces `[must be a date as YYYY-MM-DD, must be a real
 * calendar date, must not be in the future]`: the format error is the useful
 * one, and the future check only fires at all because `'yesterday' >
 * '2026-08-10'` as a *string* comparison.
 *
 * The previous `Object.fromEntries(...)` kept the LAST entry per key, which is
 * exactly how a malformed date came to be reported as a future one.
 */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};

  /** First writer wins; later issues for the same field are dropped. */
  const claim = (key: string, message: string): void => {
    if (!(key in fields)) {
      fields[key] = message;
    }
  };

  for (const issue of error.issues) {
    // AC-6. zod reports unrecognised keys as ONE issue with an empty path and
    // the offending names buried in `keys`, which would otherwise land under
    // `""` with a message a client has to parse. Expanded so each parameter
    // names itself and a typo can be highlighted directly.
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        claim(key, UNRECOGNISED);
      }
      continue;
    }

    const path = issue.path.join('.');

    if (path !== '') {
      claim(path, issue.message);
      continue;
    }

    // AC-7. A missing or non-object payload lands here — zod says "Required" or
    // "Expected object, received string", neither of which tells a client what
    // to do. Only a root type mismatch is reworded: any other pathless issue
    // (a top-level refinement, say) keeps its own message, because replacing it
    // would hide something its author meant to say.
    claim(WHOLE_BODY, issue.code === 'invalid_type' ? NOT_AN_OBJECT : issue.message);
  }

  return fields;
}
