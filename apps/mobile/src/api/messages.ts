/**
 * AC-8, AC-11. Turning a failed result into something to show a person.
 *
 * One place, not one per screen. Two of these are security properties rather
 * than copy choices, and duplicating them per form is how one eventually
 * drifts:
 *
 *   - A 401 from login gets ONE message regardless of cause. The API answers
 *     identically whether the address is unknown or the password is wrong,
 *     specifically so registration cannot be enumerated. A UI that says "no
 *     account with that email" reintroduces the oracle the server removed.
 *   - A 429 says how long to wait, from Retry-After. "Something went wrong"
 *     invites immediate retries, which extend the lockout.
 */

import type { ApiFailure, ApiOffline, ApiResult } from './client';

export const SIGN_IN_FAILED = 'Email or password is incorrect.';
export const GENERIC_FAILURE = 'Something went wrong. Please try again.';

export function rateLimitMessage(seconds: number | undefined): string {
  if (seconds === undefined) {
    return 'Too many attempts. Please wait a moment and try again.';
  }

  const unit = seconds === 1 ? 'second' : 'seconds';

  return `Too many attempts. Try again in ${seconds} ${unit}.`;
}

/**
 * `signInSafe` collapses 401 to a single message. Leave it false for endpoints
 * where the status is not an enumeration risk.
 */
export function describeFailure(
  failure: ApiFailure | ApiOffline,
  options: { signInSafe?: boolean } = {},
): string {
  if (failure.kind === 'offline') {
    return failure.message;
  }

  if (failure.status === 429) {
    return rateLimitMessage(failure.retryAfterSeconds);
  }

  if (failure.status === 401 && options.signInSafe === true) {
    return SIGN_IN_FAILED;
  }

  if (failure.status >= 500) {
    // 5xx bodies are deliberately generic server-side, so there is nothing
    // more specific to pass on.
    return GENERIC_FAILURE;
  }

  return failure.message;
}

export function isFailure<T>(
  result: ApiResult<T>,
): result is ApiFailure | ApiOffline {
  return result.kind !== 'ok';
}
