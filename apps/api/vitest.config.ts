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
    // EXP-17 AC-3. Pinned east of UTC on purpose.
    //
    // `pg` parses a `date` column into a Date at *local* midnight, so a
    // date-only value read through `toISOString()` reports the day before in any
    // positive-offset zone and is correct in UTC. CI runs in UTC, which made it
    // structurally blind to that entire class of bug — a real off-by-one lived
    // in `extraction-store.ts` through a green CI until it was found by hand.
    //
    // Pinning the developers' own zone means the suite reproduces the machine
    // this project is actually written on, and any future date-only read that
    // goes through a Date fails here rather than in production.
    env: { TZ: process.env.TZ ?? 'Asia/Kuala_Lumpur' },
  },
});
