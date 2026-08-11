/**
 * AC-4. The refresh token's home: the iOS Keychain / Android Keystore, via
 * expo-secure-store.
 *
 * Only the refresh token goes here. It is long-lived and, because presenting a
 * spent one revokes every session, it is the credential worth protecting. The
 * access token stays in memory (see session.ts).
 *
 * This module is the only place that touches the native module, so tests
 * substitute a plain in-memory object rather than mocking Expo internals.
 */

import * as SecureStore from 'expo-secure-store';
import type { SessionStorage } from './session';

const KEY = 'expenses-recorder.refreshToken';

export function createSecureStorage(): SessionStorage {
  return {
    async read() {
      try {
        return await SecureStore.getItemAsync(KEY);
      } catch {
        // A keychain read can fail on a device whose secure enclave is not
        // ready yet. Treating that as "signed out" costs one sign-in; treating
        // it as fatal would make the app unusable until a reinstall.
        return null;
      }
    },

    async write(refreshToken: string) {
      await SecureStore.setItemAsync(KEY, refreshToken);
    },

    async clear() {
      try {
        await SecureStore.deleteItemAsync(KEY);
      } catch {
        // Already absent, or unreadable. Either way there is nothing to keep.
      }
    },
  };
}

/** Exported for the test that asserts the key never silently changes. */
export const REFRESH_TOKEN_KEY = KEY;
