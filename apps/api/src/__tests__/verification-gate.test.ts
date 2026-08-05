import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parseConfig } from '../config.js';
import { createDatabase, type Database } from '../db.js';

/**
 * Guards EXP-9 AC-7b.
 *
 * `migrations/0004` grandfathers accounts that predate the verification gate.
 * Its `down` restores only the column default and never touches data, so
 * `down` followed by `up` is an ordinary rollback-and-roll-forward. If the
 * backfill were unscoped, that re-run would mark every signup currently
 * awaiting its link as verified — silently disabling the gate for exactly the
 * accounts it exists to hold back, and letting them log in without ever
 * proving they own the address.
 *
 * Running migrations inside the suite would fight the other files that share
 * this database, so this asserts the predicate the migration relies on
 * instead. The SQL below MIRRORS the migration and must be kept in step with
 * it.
 */
const config = parseConfig({
  ...process.env,
  JWT_SECRET: 'test-secret-at-least-thirty-two-chars',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  LOG_LEVEL: 'silent',
});

/** Verbatim from migrations/0004_default_email_unverified.js. */
const BACKFILL = `
  UPDATE users
  SET email_verified = true
  WHERE email_verified = false
    AND created_at < (SELECT applied_at FROM email_verification_gate)
`;

let database: Database;

beforeAll(async () => {
  database = createDatabase(config);
  await database.pool.query('SELECT 1 FROM email_verification_gate LIMIT 0');
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.pool.query('TRUNCATE users CASCADE');
});

async function seedUser(email: string, createdAt: Date): Promise<string> {
  const { rows } = await database.pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, email_verified, created_at)
     VALUES ($1, 'scrypt$16384$8$1$aa$bb', false, $2)
     RETURNING id`,
    [email, createdAt],
  );
  return rows[0]!.id;
}

async function verifiedFlags(): Promise<Record<string, boolean>> {
  const { rows } = await database.pool.query<{ email: string; email_verified: boolean }>(
    'SELECT email, email_verified FROM users',
  );
  return Object.fromEntries(rows.map((r) => [r.email, r.email_verified]));
}

describe('verification gate cutoff', () => {
  // The tests below assert the predicate, but they copy the SQL — so on their
  // own they would still pass if someone unscoped the migration itself. This
  // binds them to the real file.
  it('the migration actually scopes its backfill to the cutoff', async () => {
    const migration = await readFile(
      new URL('../../migrations/0004_default_email_unverified.js', import.meta.url),
      'utf8',
    );

    const update = migration.slice(migration.indexOf('UPDATE users'));

    expect(update).toContain('email_verified = false');
    expect(update).toContain('created_at < (SELECT applied_at FROM email_verification_gate)');
    // down() must not drop the table, or a later up() would record a fresh
    // cutoff and sweep up every pending account.
    expect(migration).not.toContain('dropTable');
    expect(migration).not.toMatch(/DROP\s+TABLE/i);
  });

  it('records exactly one immutable cutoff', async () => {
    const { rows } = await database.pool.query<{ count: string }>(
      'SELECT count(*) FROM email_verification_gate',
    );
    expect(rows[0]?.count).toBe('1');

    // A second row must be impossible, or the cutoff would be ambiguous.
    await expect(
      database.pool.query('INSERT INTO email_verification_gate (id) VALUES (true)'),
    ).rejects.toThrow();
  });

  // AC-7 — the grandfathering the gate depends on.
  it('backfills accounts that predate the cutoff', async () => {
    const { rows } = await database.pool.query<{ applied_at: Date }>(
      'SELECT applied_at FROM email_verification_gate',
    );
    const cutoff = rows[0]!.applied_at;

    await seedUser('legacy@x.com', new Date(cutoff.getTime() - 60_000));
    await database.pool.query(BACKFILL);

    expect((await verifiedFlags())['legacy@x.com']).toBe(true);
  });

  // AC-7b — the property that makes a rollback safe.
  it('leaves accounts created after the cutoff untouched, however often it runs', async () => {
    const { rows } = await database.pool.query<{ applied_at: Date }>(
      'SELECT applied_at FROM email_verification_gate',
    );
    const cutoff = rows[0]!.applied_at;

    await seedUser('legacy@x.com', new Date(cutoff.getTime() - 60_000));
    await seedUser('pending@x.com', new Date(cutoff.getTime() + 60_000));

    // Rolling back and forward repeatedly must never sweep up the pending one.
    await database.pool.query(BACKFILL);
    await database.pool.query(BACKFILL);
    await database.pool.query(BACKFILL);

    const flags = await verifiedFlags();
    expect(flags['legacy@x.com']).toBe(true);
    expect(flags['pending@x.com']).toBe(false);
  });
});
