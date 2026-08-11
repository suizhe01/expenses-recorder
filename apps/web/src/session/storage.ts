/**
 * AC-3. The web replacement for expo-secure-store.
 *
 * The refresh token goes to `localStorage`; the access token stays in memory
 * (see session.ts) and is never written here.
 *
 * **This is a real downgrade from the native version, and a deliberate one.**
 * On a phone the refresh token sat in the Secure Enclave, unreadable by any
 * other code. In a browser there is no such place: `localStorage` is readable
 * by any script running on this origin, so an XSS bug becomes a stolen
 * session. The proper answer is an httpOnly cookie, which JavaScript cannot
 * read at all — that needs the API to set and read cookies rather than return
 * bearer tokens in a JSON body, so it is its own issue (NG-2), filed next.
 *
 * `sessionStorage` was considered and rejected: it would drop the session on
 * every tab close, which for an app opened one-handed in a shop is worse than
 * the risk it avoids.
 */

import type { SessionStorage } from './session';

const KEY = 'expenses-recorder.refreshToken';

export function createWebStorage(
  store: Storage = window.localStorage,
): SessionStorage {
  return {
    async read() {
      try {
        return store.getItem(KEY);
      } catch {
        // Safari in private mode, or storage disabled entirely. Treating that
        // as "signed out" costs one sign-in; throwing would make the app
        // unusable for anyone with third-party storage locked down.
        return null;
      }
    },

    async write(refreshToken: string) {
      try {
        store.setItem(KEY, refreshToken);
      } catch {
        // Quota exceeded or storage blocked. The session still works for this
        // page load — the tokens are in memory — it just will not survive a
        // reload. Failing the sign-in outright would be worse.
      }
    },

    async clear() {
      try {
        store.removeItem(KEY);
      } catch {
        // Already gone, or unreadable. Either way there is nothing to keep.
      }
    },
  };
}

/** Exported so a test can assert the key never silently changes. */
export const REFRESH_TOKEN_KEY = KEY;
