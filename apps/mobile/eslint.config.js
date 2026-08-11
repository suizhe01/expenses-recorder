// Flat config, matching the API workspace's eslint 9 setup.
const expoConfig = require('eslint-config-expo/flat');

module.exports = [
  ...expoConfig,
  { ignores: ['node_modules/**', '.expo/**', 'dist/**'] },
  {
    // Jest's globals are injected by the test runner rather than imported.
    files: ['**/*.test.ts', '**/*.test.tsx', 'jest.setup.js', 'jest.config.js'],
    languageOptions: {
      globals: {
        jest: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        beforeEach: 'readonly',
        afterAll: 'readonly',
        afterEach: 'readonly',
      },
    },
    rules: {
      // jest.mock factories are hoisted above the imports, so a factory that
      // needs a module has to require() it inline — an import would run too
      // late. This is a constraint of the runner, not a style choice.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
];
