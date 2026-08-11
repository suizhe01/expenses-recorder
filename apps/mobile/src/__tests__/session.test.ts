import { createClient } from '../api/client';
import { createAuthApi } from '../api/auth';
import {
  createSessionManager,
  MAX_RETRY_DELAY_MS,
  SESSION_ENDED,
} from '../session/session';
import { fakeStorage, fakeTransport, instantSleep, session } from './support';

const BASE = 'http://api.test';

function build(
  routes: Parameters<typeof fakeTransport>[0],
  storedRefreshToken: string | null = null,
) {
  const http = fakeTransport(routes);
  const storage = fakeStorage(storedRefreshToken);
  const clock = instantSleep();

  const manager = createSessionManager({
    auth: createAuthApi(createClient(BASE, http.transport)),
    storage,
    sleep: clock.sleep,
  });

  return { manager, storage, clock, ...http };
}

describe('single-flight refresh (AC-5)', () => {
  /**
   * The criterion the API's 503 exists to force. If each 401 started its own
   * rotation, the server would see concurrent rotations of one session and
   * answer 503 — and worse, one of them would spend the token the others were
   * about to present, which the API treats as theft and punishes by revoking
   * every session.
   *
   * `toHaveBeenCalledTimes(1)`-style exactness is the whole assertion.
   * "At least one refresh" passes against the bug and would be worthless.
   */
  it('makes exactly one refresh call for five concurrent 401s', async () => {
    const ME = { id: 'u1', email: 'a@b.c', createdAt: 'x' };
    const { manager, countOf } = build({
      '/auth/login': { status: 200, body: session() },
      '/auth/refresh': { status: 200, body: session({ accessToken: 'access-2' }) },
      // All five initial calls must genuinely 401, or the test proves nothing:
      // if only the first did, there would be one refresh regardless of
      // whether the latch works. The sixth reply onward is the retry.
      '/auth/me': [
        { status: 401, body: { error: 'Unauthorized' } },
        { status: 401, body: { error: 'Unauthorized' } },
        { status: 401, body: { error: 'Unauthorized' } },
        { status: 401, body: { error: 'Unauthorized' } },
        { status: 401, body: { error: 'Unauthorized' } },
        { status: 200, body: ME },
      ],
    });

    // Sign in rather than restore: restore performs a rotation of its own, and
    // the assertion here has to be exactly one with nothing to subtract.
    await manager.signIn('someone@example.com', 'a'.repeat(12));

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        manager.authorized((token) => manager.auth.me(token)),
      ),
    );

    expect(countOf('/auth/me')).toBe(10);
    expect(countOf('/auth/refresh')).toBe(1);
    expect(results.every((result) => result.kind === 'ok')).toBe(true);
  });

  it('starts a new rotation for a later 401, once the first has settled', async () => {
    const { manager, countOf } = build(
      {
        '/auth/refresh': { status: 200, body: session() },
        '/auth/me': [
          { status: 401, body: { error: 'Unauthorized' } },
          { status: 200, body: { id: 'u1', email: 'a@b.c', createdAt: 'x' } },
          { status: 401, body: { error: 'Unauthorized' } },
          { status: 200, body: { id: 'u1', email: 'a@b.c', createdAt: 'x' } },
        ],
      },
      'stored-refresh',
    );

    await manager.restore();
    expect(countOf('/auth/refresh')).toBe(1);

    await manager.authorized((token) => manager.auth.me(token));
    await manager.authorized((token) => manager.auth.me(token));

    // The latch must clear when a rotation settles, or the session could never
    // recover from a second expiry.
    expect(countOf('/auth/refresh')).toBe(3);
  });
});

describe('401 handling (AC-6)', () => {
  it('refreshes once and retries the original request once', async () => {
    const { manager, countOf } = build(
      {
        '/auth/refresh': { status: 200, body: session() },
        '/auth/me': [
          { status: 401, body: { error: 'Unauthorized' } },
          { status: 200, body: { id: 'u1', email: 'me@example.com', createdAt: 'x' } },
        ],
      },
      'stored-refresh',
    );

    await manager.restore();
    const result = await manager.authorized((token) => manager.auth.me(token));

    expect(result.kind).toBe('ok');
    expect(countOf('/auth/me')).toBe(2);
  });

  /**
   * The failure mode to exclude: against an API that answers 401 to
   * everything, a retry loop refreshes forever while the user watches a
   * spinner. One retry, then give up.
   */
  it('does not retry a second time when the refreshed token is also rejected', async () => {
    const { manager, countOf, storage } = build({
      '/auth/login': { status: 200, body: session() },
      '/auth/refresh': { status: 200, body: session() },
      '/auth/me': { status: 401, body: { error: 'Unauthorized' } },
    });

    await manager.signIn('someone@example.com', 'a'.repeat(12));
    const result = await manager.authorized((token) => manager.auth.me(token));

    expect(result.kind).toBe('error');
    expect(countOf('/auth/me')).toBe(2);
    expect(countOf('/auth/refresh')).toBe(1);
    // Still signed in: the session is fine, this endpoint just keeps refusing.
    expect(storage.value).not.toBeNull();
  });

  it('signs out with a message when the refresh itself fails', async () => {
    const { manager, storage } = build(
      {
        '/auth/refresh': [
          { status: 200, body: session() },
          { status: 401, body: { error: 'Invalid refresh token' } },
        ],
        '/auth/me': { status: 401, body: { error: 'Unauthorized' } },
      },
      'stored-refresh',
    );

    await manager.restore();
    await manager.authorized((token) => manager.auth.me(token));

    expect(manager.getState()).toEqual({
      status: 'signed-out',
      reason: SESSION_ENDED,
    });
    expect(storage.value).toBeNull();
  });
});

describe('503 during refresh (AC-7)', () => {
  it('retries twice honouring Retry-After, then succeeds', async () => {
    const { manager, countOf, clock } = build(
      {
        '/auth/refresh': [
          { status: 503, body: { error: 'busy' }, headers: { 'retry-after': '1' } },
          { status: 503, body: { error: 'busy' }, headers: { 'retry-after': '2' } },
          { status: 200, body: session() },
        ],
      },
      'stored-refresh',
    );

    await manager.restore();

    expect(countOf('/auth/refresh')).toBe(3);
    expect(clock.slept).toEqual([1000, 2000]);
    expect(manager.getState().status).toBe('signed-in');
  });

  it('gives up after the third 503 and signs out', async () => {
    const { manager, countOf, storage } = build(
      {
        '/auth/refresh': { status: 503, body: { error: 'busy' } },
      },
      'stored-refresh',
    );

    await manager.restore();

    expect(countOf('/auth/refresh')).toBe(3);
    expect(manager.getState().status).toBe('signed-out');
    expect(storage.value).toBeNull();
  });

  it('bounds an absurd Retry-After rather than hanging the app', async () => {
    const { manager, clock } = build(
      {
        '/auth/refresh': [
          { status: 503, body: {}, headers: { 'retry-after': '86400' } },
          { status: 200, body: session() },
        ],
      },
      'stored-refresh',
    );

    await manager.restore();

    expect(clock.slept).toEqual([MAX_RETRY_DELAY_MS]);
  });

  it('does not retry a 401, which is terminal rather than transient', async () => {
    const { manager, countOf } = build(
      { '/auth/refresh': { status: 401, body: { error: 'Invalid refresh token' } } },
      'stored-refresh',
    );

    await manager.restore();

    expect(countOf('/auth/refresh')).toBe(1);
  });
});

describe('cold start (AC-9)', () => {
  it('rotates a stored token and lands signed in', async () => {
    const { manager, storage } = build(
      { '/auth/refresh': { status: 200, body: session({ refreshToken: 'rotated' }) } },
      'stored-refresh',
    );

    await manager.restore();

    expect(manager.getState()).toEqual({
      status: 'signed-in',
      user: session().user,
    });
    // Rotation persisted. Keeping the spent one would trip theft detection on
    // the next launch and revoke every session.
    expect(storage.value).toBe('rotated');
  });

  it('goes straight to signed-out with no message when nothing is stored', async () => {
    const { manager, countOf } = build({ '/auth/refresh': { status: 200, body: session() } });

    await manager.restore();

    // No message: the user did not do anything, they opened the app.
    expect(manager.getState()).toEqual({ status: 'signed-out' });
    expect(countOf('/auth/refresh')).toBe(0);
  });

  it('reports restoring before it settles, so no screen renders too early', async () => {
    const { manager } = build(
      { '/auth/refresh': { status: 200, body: session() } },
      'stored-refresh',
    );

    const seen: string[] = [];
    manager.subscribe((next) => seen.push(next.status));

    await manager.restore();

    expect(seen[0]).toBe('restoring');
    expect(seen.at(-1)).toBe('signed-in');
  });
});

describe('sign in and sign out', () => {
  it('stores the refresh token on a successful sign in', async () => {
    const { manager, storage } = build({
      '/auth/login': { status: 200, body: session({ refreshToken: 'fresh' }) },
    });

    const result = await manager.signIn('someone@example.com', 'a'.repeat(12));

    expect(result.kind).toBe('ok');
    expect(storage.value).toBe('fresh');
    expect(manager.getState().status).toBe('signed-in');
  });

  it('leaves nothing stored when sign in fails', async () => {
    const { manager, storage } = build({
      '/auth/login': { status: 401, body: { error: 'Invalid email or password' } },
    });

    await manager.signIn('someone@example.com', 'wrong-password');

    expect(storage.value).toBeNull();
    expect(manager.getState().status).not.toBe('signed-in');
  });

  /**
   * AC-13. Logout is idempotent server-side, so there is no server answer
   * worth keeping someone signed in for — and a network failure must not trap
   * a user in a session they asked to leave.
   */
  it('signs out locally even when the server call fails', async () => {
    const { manager, storage } = build(
      {
        '/auth/refresh': { status: 200, body: session() },
        '/auth/logout': { status: 500, body: { error: 'Internal Server Error' } },
      },
      'stored-refresh',
    );

    await manager.restore();
    await manager.signOut();

    expect(manager.getState()).toEqual({ status: 'signed-out' });
    expect(storage.value).toBeNull();
  });
});
