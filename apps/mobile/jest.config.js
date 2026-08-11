/**
 * jest-expo supplies the React Native preset: the Metro-style module
 * resolution, the platform extensions, and the transform for the untranspiled
 * ESM that ships inside react-native and the expo packages.
 */
module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx'],
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/*.test.{ts,tsx}'],
};
