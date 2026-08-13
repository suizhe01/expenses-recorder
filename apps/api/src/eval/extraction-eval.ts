import type { ExtractedFields } from '../receipts/extraction.js';

/** Everything the paper receipt can establish; model confidence is not one of them. */
export type ExpectedExtraction = Omit<ExtractedFields, 'confidence'>;

export type Difference = { path: string; expected: unknown; actual: unknown };

export function compareExtraction(expected: ExpectedExtraction, actual: ExtractedFields): Difference[] {
  return compare(expected, actual, '');
}

function compare(expected: unknown, actual: unknown, path: string): Difference[] {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [{ path, expected, actual }];
    const differences: Difference[] = expected.length === actual.length
      ? []
      : [{ path: `${path}.length`, expected: expected.length, actual: actual.length }];
    return differences.concat(expected.flatMap((value, index) => compare(value, actual[index], `${path}[${index}]`)));
  }

  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return [{ path, expected, actual }];
    return Object.entries(expected).flatMap(([key, value]) => compare(value, (actual as Record<string, unknown>)[key], path ? `${path}.${key}` : key));
  }

  return Object.is(expected, actual) ? [] : [{ path, expected, actual }];
}
