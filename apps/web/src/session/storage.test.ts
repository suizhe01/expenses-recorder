import { describe, expect, it } from 'vitest';
import { createWebStorage, REFRESH_TOKEN_KEY } from '@/session/storage';

describe('web storage adapter (AC-3)', () => {
  /**
   * If this fails the rest of the file proves nothing. The adapter has to work
   * against a genuine Web Storage, and Node 26's disabled built-in shadows the
   * one the DOM environment provides — see src/test/setup.ts for how it is put
   * back.
   */
  it('runs against a real Storage, not a hand-written stub', () => {
    expect(typeof window.localStorage).toBe('object');
    expect(window.localStorage).toBeInstanceOf(Object);

    // The full Storage surface, not just the three methods the adapter calls.
    for (const member of ['getItem', 'setItem', 'removeItem', 'clear', 'key']) {
      expect(typeof (window.localStorage as unknown as Record<string, unknown>)[member]).toBe(
        'function',
      );
    }

    expect(typeof window.localStorage.length).toBe('number');
  });

  it('round-trips the refresh token', async () => {
    const storage = createWebStorage();

    expect(await storage.read()).toBeNull();

    await storage.write('refresh-1');
    expect(await storage.read()).toBe('refresh-1');

    await storage.clear();
    expect(await storage.read()).toBeNull();
  });

  it('writes under a stable key', async () => {
    await createWebStorage().write('refresh-1');

    // Renaming the key silently signs every existing user out on deploy.
    expect(window.localStorage.getItem(REFRESH_TOKEN_KEY)).toBe('refresh-1');
    expect(REFRESH_TOKEN_KEY).toBe('expenses-recorder.refreshToken');
  });

  /**
   * The access token is short-lived and reconstructible from the refresh
   * token, so persisting it would add disk exposure for nothing. This asserts
   * the adapter stores exactly one thing.
   */
  it('stores nothing but the refresh token', async () => {
    await createWebStorage().write('refresh-1');

    expect(window.localStorage.length).toBe(1);
    expect(window.localStorage.key(0)).toBe(REFRESH_TOKEN_KEY);
  });

  /**
   * Safari in private mode, and any browser with storage blocked, throw on
   * access. The session should degrade to "signed out" rather than the app
   * refusing to load — a thrown error here would reach the user as a blank
   * page with no explanation.
   */
  it('degrades rather than throwing when storage is unavailable', async () => {
    const blocked = {
      getItem() {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem() {
        throw new DOMException('denied', 'SecurityError');
      },
      removeItem() {
        throw new DOMException('denied', 'SecurityError');
      },
    } as unknown as Storage;

    const storage = createWebStorage(blocked);

    await expect(storage.read()).resolves.toBeNull();
    await expect(storage.write('refresh-1')).resolves.toBeUndefined();
    await expect(storage.clear()).resolves.toBeUndefined();
  });
});
