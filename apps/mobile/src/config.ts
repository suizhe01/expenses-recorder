/**
 * AC-2. The API origin, validated at startup.
 *
 * Same contract as the API's own config module: a missing or malformed value
 * stops the app immediately with a message naming the variable, rather than
 * letting it run and fail later as an unexplained network error. There is
 * deliberately NO default — `localhost` would be the obvious one and it is
 * wrong on a physical device, where it means the phone itself.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const VARIABLE = 'EXPO_PUBLIC_API_URL';

export function parseApiBaseUrl(value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(
      `${VARIABLE} is not set. Copy apps/mobile/.env.example to ` +
        'apps/mobile/.env and point it at your API, e.g. ' +
        'http://192.168.1.10:3000 — not localhost, which on a phone means ' +
        'the phone itself.',
    );
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(
      `${VARIABLE} must be an absolute URL, got "${value}".`,
    );
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(
      `${VARIABLE} must be http:// or https://, got "${url.protocol}".`,
    );
  }

  // Stored without a trailing slash so callers can join paths as `${base}/auth/login`
  // without producing a double slash, which some proxies redirect and others 404.
  return value.replace(/\/+$/, '');
}

/**
 * Read lazily rather than at module load. Evaluating at import time would make
 * every test file that touches the API layer need the variable set, and would
 * throw during a Jest module registry reset before any test could assert on it.
 */
export function apiBaseUrl(): string {
  // Expo inlines EXPO_PUBLIC_* at build time, so this must be a static member
  // expression — a computed lookup like process.env[name] is not replaced.
  return parseApiBaseUrl(process.env.EXPO_PUBLIC_API_URL);
}
