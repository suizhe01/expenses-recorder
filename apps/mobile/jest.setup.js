/**
 * expo-secure-store is a native module with no JavaScript implementation in
 * Jest. Only storage.ts imports it, and the session logic takes storage as a
 * dependency, so this mock exists to keep the module graph resolvable rather
 * than to be exercised — the tests inject their own in-memory storage.
 */
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

/**
 * The API origin is normally read from the environment at call time. Setting
 * it here means a test that renders a screen does not have to.
 */
process.env.EXPO_PUBLIC_API_URL = 'http://127.0.0.1:3000';
