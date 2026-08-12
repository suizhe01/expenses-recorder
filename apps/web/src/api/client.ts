/**
 * AC-3. The HTTP layer.
 *
 * Every call returns a discriminated result rather than throwing. A thrown
 * string loses the status code, and the status code is the whole contract
 * here: 401 and 403 mean different screens, 429 and 503 mean different retry
 * behaviour. Callers that pattern-match on `kind` cannot forget one.
 *
 * The transport is injected for the same reason the API injects its email and
 * extraction dependencies (AC-15): no test may make a network call.
 */

export type Transport = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

/** A response the server produced, whatever its status. */
export type ApiOk<T> = { kind: 'ok'; status: number; body: T };

/** 4xx or 5xx with a parsed body, if there was one. */
export type ApiFailure = {
  kind: 'error';
  status: number;
  /** Server-supplied message, or a generic one when the body had none. */
  message: string;
  /** Per-field messages from the API's validation shape, when present. */
  fields?: Record<string, string>;
  /** The API's machine-readable discriminator, e.g. EMAIL_NOT_VERIFIED. */
  code?: string;
  /** Seconds, parsed from Retry-After. Present on 429 and sometimes 503. */
  retryAfterSeconds?: number;
};

/** The request never reached the server, or the response was unreadable. */
export type ApiOffline = { kind: 'offline'; message: string };

export type ApiResult<T> = ApiOk<T> | ApiFailure | ApiOffline;

export type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Sent as `Authorization: Bearer …` when present. */
  accessToken?: string;
};

/**
 * AC-8. `Retry-After` is defined as either delay-seconds or an HTTP-date.
 * Fastify's rate limiter sends seconds; the date form is handled because a
 * proxy in front may rewrite it, and a NaN countdown reaches the user as
 * "try again in NaN seconds".
 */
export function parseRetryAfter(
  header: string | null,
  now: number = Date.now(),
): number | undefined {
  if (header === null || header.trim() === '') {
    return undefined;
  }

  const seconds = Number(header);

  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.ceil(seconds));
  }

  const date = Date.parse(header);

  if (Number.isNaN(date)) {
    return undefined;
  }

  return Math.max(0, Math.ceil((date - now) / 1000));
}

const GENERIC_ERROR = 'Something went wrong. Please try again.';

export function createClient(baseUrl: string, transport: Transport) {
  return async function request<T>(
    path: string,
    options: RequestOptions = {},
  ): Promise<ApiResult<T>> {
    const { method = 'GET', body, accessToken } = options;

    const headers: Record<string, string> = { accept: 'application/json' };

    const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;

    if (body !== undefined && !isFormData) {
      headers['content-type'] = 'application/json';
    }

    if (accessToken !== undefined) {
      headers.authorization = `Bearer ${accessToken}`;
    }

    let response: Response;

    try {
      response = await transport(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: isFormData ? body : JSON.stringify(body) }),
      });
    } catch {
      // A DNS failure, a refused connection, aeroplane mode. Distinct from an
      // error response: there is no status to reason about, and the user's
      // action is different — check the connection, not the credentials.
      return {
        kind: 'offline',
        message: 'Could not reach the server. Check your connection.',
      };
    }

    // 204 has no body by definition; logout relies on this.
    const raw = response.status === 204 ? '' : await response.text().catch(() => '');
    let parsed: unknown = undefined;

    if (raw !== '') {
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Not JSON. The verify and reset-password routes answer HTML, and a
        // proxy error page is HTML too, so this is expected rather than odd.
        parsed = undefined;
      }
    }

    if (response.ok) {
      return { kind: 'ok', status: response.status, body: parsed as T };
    }

    const shape = (parsed ?? {}) as {
      error?: unknown;
      code?: unknown;
      fields?: unknown;
    };

    return {
      kind: 'error',
      status: response.status,
      message: typeof shape.error === 'string' ? shape.error : GENERIC_ERROR,
      ...(typeof shape.code === 'string' ? { code: shape.code } : {}),
      ...(isFieldMap(shape.fields) ? { fields: shape.fields } : {}),
      ...(() => {
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        return retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter };
      })(),
    };
  };
}

function isFieldMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

export type ApiRequest = ReturnType<typeof createClient>;
