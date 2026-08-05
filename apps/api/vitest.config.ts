import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    reporters: ['verbose'],
    // The integration suites share one Postgres and each truncates between
    // tests, so running files in parallel lets them delete each other's rows.
    // Sequential files keep the database a single coherent fixture.
    fileParallelism: false,
  },
});
