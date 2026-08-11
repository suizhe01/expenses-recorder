/**
 * AC-4 to AC-9. Session lifetime, token rotation, and the retry policy.
 *
 * Deliberately free of React and of native modules: the storage and the API
 * are injected, so every rule below is testable without a renderer, a device,
 * or a network (AC-15). The React binding is a thin layer in context.tsx.
 *
 * The rotation contract this has to respect, from apps/api/src/routes/auth.ts:
 *
 *   - Refreshing REPLACES both tokens. The old refresh token is spent.
 *   - Presenting a spent refresh token is treated as THEFT and revokes every
 *     session for that user. So the rotated value must be persisted before
 *     anything else can use it, and a token must never be sent twice.
 *   - Two rotations of one session in flight together answer 503 + Retry-After.
 *     That is the server telling us to serialise, which is why refresh here is
 *     single-flight (AC-5) rather than per-request.
 */

import type { ApiResult } from '../api/client';
import type { AuthApi, Session, User } from '../api/auth';

export type SessionStorage = {
  /** The stored refresh token, or null when signed out. */
  read(): Promise<string | null>;
  write(refreshToken: string): Promise<void>;
  clear(): Promise<void>;
};

export type SessionState =
  /** Cold start: deciding where to send the user. AC-9. */
  | { status: 'restoring' }
  | { status: 'signed-out'; reason?: string }
  | { status: 'signed-in'; user: User };

export const SESSION_ENDED = 'Your session ended. Please sign in again.';

/** AC-7. One initial attempt plus this many retries. */
export const REFRESH_503_RETRIES = 2;

/**
 * A server could answer `Retry-After: 86400`. Waiting a day inside a mobile app
 * is indistinguishable from a hang, so the honoured delay is bounded.
 */
export const MAX_RETRY_DELAY_MS = 5_000;

export type SessionDeps = {
  auth: AuthApi;
  storage: SessionStorage;
  /** Injected so tests do not spend real seconds waiting out Retry-After. */
  sleep?: (ms: number) => Promise<void>;
};

type RefreshOutcome =
  | { ok: true; accessToken: string }
  | { ok: false; reason: string };

export function createSessionManager({
  auth,
  storage,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: SessionDeps) {
  // AC-4. In memory only, never written to storage. It lives ~15 minutes and
  // is reconstructible from the refresh token, so persisting it would add disk
  // exposure for no gain.
  let accessToken: string | null = null;
  let refreshToken: string | null = null;
  let user: User | null = null;

  let state: SessionState = { status: 'restoring' };
  const listeners = new Set<(next: SessionState) => void>();

  // AC-5. The single-flight latch. While a rotation is running every other
  // caller awaits THIS promise instead of starting a second one.
  let refreshInFlight: Promise<RefreshOutcome> | null = null;

  function setState(next: SessionState): void {
    state = next;
    for (const listener of listeners) {
      listener(next);
    }
  }

  function adopt(session: Session): void {
    accessToken = session.accessToken;
    refreshToken = session.refreshToken;
    user = session.user;
  }

  async function forget(reason?: string): Promise<void> {
    accessToken = null;
    refreshToken = null;
    user = null;
    await storage.clear();
    setState({ status: 'signed-out', ...(reason === undefined ? {} : { reason }) });
  }

  /**
   * AC-7. The rotation itself, retrying only on 503.
   *
   * 503 means "another rotation of this session is in flight" — transient by
   * definition. Every other failure is terminal: a 401 here means the token is
   * expired, revoked, or was already spent, and re-sending it would look even
   * more like theft.
   */
  async function rotate(presented: string): Promise<RefreshOutcome> {
    let token = presented;

    for (let attempt = 0; attempt <= REFRESH_503_RETRIES; attempt += 1) {
      const result = await auth.refresh(token);

      if (result.kind === 'ok') {
        adopt(result.body);
        // Persisted immediately. If the app dies between the server rotating
        // and this write, the stored token is already spent and the next
        // launch trips theft detection — so this is the narrowest window we
        // can make it, not merely tidy ordering.
        await storage.write(result.body.refreshToken);
        return { ok: true, accessToken: result.body.accessToken };
      }

      const isLastAttempt = attempt === REFRESH_503_RETRIES;

      if (result.kind === 'error' && result.status === 503 && !isLastAttempt) {
        const seconds = result.retryAfterSeconds ?? 1;
        await sleep(Math.min(seconds * 1000, MAX_RETRY_DELAY_MS));
        continue;
      }

      return { ok: false, reason: SESSION_ENDED };
    }

    /* istanbul ignore next — the loop always returns. */
    return { ok: false, reason: SESSION_ENDED };
  }

  /**
   * AC-5. Every caller that needs a fresh access token goes through here.
   * Concurrent callers share one rotation; the latch is cleared only after it
   * settles, so a later 401 can start a new one.
   */
  function refresh(): Promise<RefreshOutcome> {
    if (refreshInFlight !== null) {
      return refreshInFlight;
    }

    const current = refreshToken;

    if (current === null) {
      return Promise.resolve({ ok: false, reason: SESSION_ENDED });
    }

    refreshInFlight = rotate(current).finally(() => {
      refreshInFlight = null;
    });

    return refreshInFlight;
  }

  return {
    /**
     * Exposed so screens can make authenticated calls through `authorized`
     * without building a second client — and so a test can hand the whole
     * thing a fake. Screens never construct API functions themselves.
     */
    auth,

    getState: (): SessionState => state,

    subscribe(listener: (next: SessionState) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * AC-9. Cold start. The access token did not survive the process, so a
     * stored refresh token is rotated to prove the session is still live
     * before the user is shown a signed-in screen.
     */
    async restore(): Promise<void> {
      setState({ status: 'restoring' });

      const stored = await storage.read();

      if (stored === null) {
        setState({ status: 'signed-out' });
        return;
      }

      refreshToken = stored;

      const outcome = await refresh();

      if (!outcome.ok || user === null) {
        // No message: the user did not do anything, they just opened the app.
        // "Your session ended" on a cold start reads as an error they caused.
        await forget();
        return;
      }

      setState({ status: 'signed-in', user });
    },

    /**
     * AC-6. Runs an authenticated call, refreshing once on 401 and retrying
     * the original request exactly once.
     *
     * Once — not in a loop. Against an API that answers 401 to everything, a
     * loop would refresh and retry forever while the user watches a spinner.
     */
    async authorized<T>(
      call: (token: string) => Promise<ApiResult<T>>,
    ): Promise<ApiResult<T>> {
      if (accessToken === null) {
        const outcome = await refresh();

        if (!outcome.ok) {
          await forget(outcome.reason);
          return { kind: 'error', status: 401, message: outcome.reason };
        }

        return call(outcome.accessToken);
      }

      const first = await call(accessToken);

      if (first.kind !== 'error' || first.status !== 401) {
        return first;
      }

      const outcome = await refresh();

      if (!outcome.ok) {
        await forget(outcome.reason);
        return { kind: 'error', status: 401, message: outcome.reason };
      }

      return call(outcome.accessToken);
    },

    async signIn(email: string, password: string): Promise<ApiResult<Session>> {
      const result = await auth.login(email, password);

      if (result.kind === 'ok') {
        adopt(result.body);
        await storage.write(result.body.refreshToken);
        setState({ status: 'signed-in', user: result.body.user });
      }

      return result;
    },

    /**
     * AC-13. Local sign-out is unconditional. `POST /auth/logout` is idempotent
     * server-side and answers 204 for an unknown or already-revoked token, so
     * there is no failure worth keeping the user signed in for — and a network
     * error must not trap them in a session they asked to leave.
     */
    async signOut(): Promise<void> {
      const current = refreshToken;

      if (current !== null) {
        await auth.logout(current);
      }

      await forget();
    },
  };
}

export type SessionManager = ReturnType<typeof createSessionManager>;
