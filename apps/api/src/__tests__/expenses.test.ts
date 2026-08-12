import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { fromBuffer } from 'yauzl';
import { buildApp } from '../app.js';
import { parseConfig, type Config } from '../config.js';
import { createDatabase, type Database } from '../db.js';
import type { EmailTransport } from '../email/transport.js';
import type { ReceiptExtractor } from '../receipts/extraction.js';
import { todayInMalaysia } from '../routes/expenses.js';
import { hashDownloadToken } from '../exports/tokens.js';

const PASSWORD = 'correcthorsebattery';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

/** A date in the past, so it is valid whenever this suite runs. */
const PURCHASED_ON = '2026-08-08';

let root: string;
let config: Config;
let database: Database;
let app: FastifyInstance;

/** Registration sends mail; nothing here asserts on it. See categories.test.ts. */
const silentTransport: EmailTransport = {
  name: 'silent',
  sendVerificationEmail: async () => {},
  sendPasswordResetEmail: async () => {},
};

/**
 * Uploads here exist only to give expenses something to attach to. Without an
 * injected extractor `buildApp` picks the real Gemini one whenever
 * GEMINI_API_KEY is in the environment, and every upload becomes a live call.
 */
const skippingExtractor: ReceiptExtractor = {
  model: 'fake-model',
  extract: async () => ({ status: 'skipped' }),
};

function jpeg(tag: string): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from(`padding-${tag}`.padEnd(32, '.')),
  ]);
}

function multipart(content: Buffer) {
  const boundary = `----vitest${randomBytes(8).toString('hex')}`;

  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          'Content-Disposition: form-data; name="file"; filename="receipt.jpg"\r\n' +
          'Content-Type: image/jpeg\r\n\r\n',
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'exp16-expenses-'));
  config = parseConfig({
    ...process.env,
    JWT_SECRET: 'test-secret-at-least-thirty-two-chars',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    LOG_LEVEL: 'silent',
    RECEIPTS_PATH: root,
  });
  database = createDatabase(config);
  await database.pool.query('SELECT 1 FROM expenses LIMIT 0');
});

afterAll(async () => {
  await database.close();
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await database.pool.query('TRUNCATE users CASCADE');
  app = buildApp({
    config,
    database,
    emailTransport: silentTransport,
    extractor: skippingExtractor,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

type Account = { token: string; userId: string };

async function account(email: string): Promise<Account> {
  const registration = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password: PASSWORD },
  });
  expect(registration.statusCode, registration.body).toBe(201);

  await database.pool.query('UPDATE users SET email_verified = true WHERE email = $1', [
    email,
  ]);

  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });

  const { rows } = await database.pool.query<{ id: string }>(
    'SELECT id FROM users WHERE email = $1',
    [email],
  );

  return {
    token: (login.json() as { accessToken: string }).accessToken,
    userId: rows[0]!.id,
  };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

type Category = { id: string; name: string };

async function categories(token: string): Promise<Category[]> {
  const response = await app.inject({
    method: 'GET',
    url: '/categories',
    headers: auth(token),
  });

  return response.json() as Category[];
}

async function categoryNamed(token: string, name: string): Promise<string> {
  const found = (await categories(token)).find((c) => c.name === name);

  if (!found) {
    throw new Error(`no category named ${name}`);
  }

  return found.id;
}

async function upload(token: string, tag = 'a'): Promise<string> {
  const { headers, payload } = multipart(jpeg(tag));
  const response = await app.inject({
    method: 'POST',
    url: '/receipts',
    headers: { ...headers, ...auth(token) },
    payload,
  });

  return (response.json() as { id: string }).id;
}

function create(token: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: '/expenses',
    headers: auth(token),
    payload: payload as never,
  });
}

function fetchOne(token: string, id: string) {
  return app.inject({ method: 'GET', url: `/expenses/${id}`, headers: auth(token) });
}

function list(token: string) {
  return app.inject({ method: 'GET', url: '/expenses', headers: auth(token) });
}

function patch(token: string, id: string, payload: unknown) {
  return app.inject({
    method: 'PATCH',
    url: `/expenses/${id}`,
    headers: auth(token),
    payload: payload as never,
  });
}

function remove(token: string, id: string) {
  return app.inject({ method: 'DELETE', url: `/expenses/${id}`, headers: auth(token) });
}

type Expense = {
  id: string;
  category: { id: string; name: string };
  receiptId: string | null;
  purchasedOn: string;
  purchasedAtTime: string | null;
  totalCents: number;
  subtotalCents: number | null;
  taxCents: number | null;
  roundingCents: number | null;
  currency: string;
  merchantName: string | null;
  merchantTaxId: string | null;
  receiptNumber: string | null;
  paymentMethod: string | null;
  note: string | null;
  items: {
    description: string | null;
    quantity: string | null;
    unitPriceCents: number | null;
    lineTotalCents: number | null;
  }[];
  createdAt: string;
  updatedAt: string;
};

/** The minimum a valid expense needs (AC-4). */
async function minimal(token: string, overrides: Record<string, unknown> = {}) {
  return {
    categoryId: await categoryNamed(token, 'Food'),
    totalCents: 2685,
    purchasedOn: PURCHASED_ON,
    ...overrides,
  };
}

async function anExpense(token: string, overrides: Record<string, unknown> = {}) {
  const response = await create(token, await minimal(token, overrides));

  expect(response.statusCode).toBe(201);

  return response.json() as Expense;
}

function fields(response: { json: () => unknown }): Record<string, string> {
  return (response.json() as { fields: Record<string, string> }).fields;
}

describe('schema', () => {
  it('AC-3: one live expense per receipt, ignoring deleted rows and nulls', async () => {
    const { rows } = await database.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'expenses' AND indexname = 'expenses_receipt_id_live_unique'`,
    );

    expect(rows[0]?.indexdef).toContain('UNIQUE');
    expect(rows[0]?.indexdef).toContain('deleted_at IS NULL');
    expect(rows[0]?.indexdef).toContain('receipt_id IS NOT NULL');
  });

  it('AC-3: the listing index orders purchases descending', async () => {
    const { rows } = await database.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'expenses' AND indexname = 'expenses_user_id_purchased_on_idx'`,
    );

    expect(rows[0]?.indexdef).toContain('purchased_on DESC');
  });

  /**
   * AC-2. The behaviour the FK choice exists for, rather than an assertion about
   * the catalogue: RESTRICT is checked per row and fails depending on the order
   * a cascade happens to delete in, where NO ACTION defers to the end of the
   * statement and sees a consistent world.
   */
  it('AC-2: deleting a user removes their expenses instead of erroring', async () => {
    const { token, userId } = await account('cascade@example.com');
    const receiptId = await upload(token);
    await anExpense(token, { receiptId });

    await expect(
      database.pool.query('DELETE FROM users WHERE id = $1', [userId]),
    ).resolves.toBeTruthy();

    const { rows } = await database.pool.query<{ count: string }>(
      'SELECT count(*) FROM expenses WHERE user_id = $1',
      [userId],
    );
    expect(Number(rows[0]!.count)).toBe(0);
  });

  it('AC-2: the foreign keys use NO ACTION, not RESTRICT', async () => {
    const { rows } = await database.pool.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype FROM pg_constraint
       WHERE conrelid = 'expenses'::regclass AND contype = 'f'
       ORDER BY conname`,
    );

    const byName = new Map(rows.map((r) => [r.conname, r.confdeltype]));

    // 'a' is NO ACTION, 'r' is RESTRICT, 'c' is CASCADE.
    expect(byName.get('expenses_category_id_fkey')).toBe('a');
    expect(byName.get('expenses_receipt_id_fkey')).toBe('a');
    expect(byName.get('expenses_user_id_fkey')).toBe('c');
  });
});

describe('POST /expenses', () => {
  it('EXP-40 AC-5, AC-7: stores item rows, trims text, and drops empty rows', async () => {
    const { token } = await account('item-create@example.com');
    const expense = await anExpense(token, {
      items: [
        { description: '  Roti canai ', quantity: ' 2 ', unitPriceCents: 150, lineTotalCents: 300 },
        { description: ' ', quantity: '', unitPriceCents: null, lineTotalCents: null },
      ],
    });

    expect(expense.items).toEqual([
      { description: 'Roti canai', quantity: '2', unitPriceCents: 150, lineTotalCents: 300 },
    ]);
    expect((await fetchOne(token, expense.id)).json()).toMatchObject({ items: expense.items });
    expect((await list(token)).json()).toMatchObject([{ items: expense.items }]);

    const { rows } = await database.pool.query<{ items: unknown }>(
      'SELECT items FROM expenses WHERE id = $1', [expense.id],
    );
    expect(rows[0]!.items).toEqual(expense.items);
  });

  it('EXP-40 AC-7: rejects malformed item fields by name', async () => {
    const { token } = await account('item-invalid@example.com');
    for (const [field, value] of [
      ['description', 'x'.repeat(501)],
      ['quantity', 'x'.repeat(51)],
      ['unitPriceCents', -1],
      ['lineTotalCents', 1.5],
    ] as const) {
      const response = await create(token, await minimal(token, { items: [{ [field]: value }] }));
      expect(response.statusCode).toBe(400);
      expect(fields(response)).toHaveProperty(`items.0.${field}`);
    }
  });
  it('AC-4: records an expense from the three required fields', async () => {
    const { token } = await account('create@example.com');

    const expense = await anExpense(token);

    expect(expense.totalCents).toBe(2685);
    expect(expense.purchasedOn).toBe(PURCHASED_ON);
    expect(expense.category.name).toBe('Food');
    expect(expense.receiptId).toBeNull();
  });

  it('AC-5: stores every optional field, and nulls the ones left out', async () => {
    const { token } = await account('full@example.com');
    const receiptId = await upload(token);

    const expense = await anExpense(token, {
      receiptId,
      purchasedAtTime: '14:31:00',
      subtotalCents: 2580,
      taxCents: 103,
      roundingCents: 2,
      merchantName: 'Master Prawn Mee',
      merchantTaxId: '202103359487',
      receiptNumber: 'INV/2608/00291',
      paymentMethod: 'Cash',
      note: 'lunch in Melaka',
    });

    expect(expense).toMatchObject({
      receiptId,
      purchasedAtTime: '14:31:00',
      subtotalCents: 2580,
      taxCents: 103,
      roundingCents: 2,
      currency: 'MYR',
      merchantName: 'Master Prawn Mee',
      merchantTaxId: '202103359487',
      receiptNumber: 'INV/2608/00291',
      paymentMethod: 'Cash',
      note: 'lunch in Melaka',
    });

    const bare = await anExpense(token);
    expect(bare.purchasedAtTime).toBeNull();
    expect(bare.subtotalCents).toBeNull();
    expect(bare.taxCents).toBeNull();
    expect(bare.roundingCents).toBeNull();
    expect(bare.merchantName).toBeNull();
    expect(bare.note).toBeNull();
  });

  it('AC-6: names each missing required field', async () => {
    const { token } = await account('missing@example.com');
    const full = await minimal(token);

    for (const field of ['categoryId', 'totalCents', 'purchasedOn'] as const) {
      const payload = { ...full };
      delete (payload as Record<string, unknown>)[field];

      const response = await create(token, payload);

      expect(response.statusCode).toBe(400);
      expect(fields(response)).toHaveProperty(field);
    }
  });

  it('AC-6: rejects a total that is zero, negative, or fractional', async () => {
    const { token } = await account('total@example.com');

    for (const totalCents of [0, -500, 12.5]) {
      const response = await create(token, await minimal(token, { totalCents }));

      expect(response.statusCode).toBe(400);
      expect(fields(response)).toHaveProperty('totalCents');
    }
  });

  it('AC-6: rejects negative components but accepts negative rounding', async () => {
    const { token } = await account('components@example.com');

    for (const field of ['subtotalCents', 'taxCents'] as const) {
      const response = await create(token, await minimal(token, { [field]: -1 }));

      expect(response.statusCode).toBe(400);
      expect(fields(response)).toHaveProperty(field);
    }

    // Malaysian receipts round down as often as up.
    const rounded = await anExpense(token, { roundingCents: -2 });
    expect(rounded.roundingCents).toBe(-2);
  });

  it('AC-7: refuses a future date and accepts today', async () => {
    const { token } = await account('future@example.com');
    const today = todayInMalaysia();
    const tomorrow = new Date(`${today}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

    const refused = await create(
      token,
      await minimal(token, { purchasedOn: tomorrow.toISOString().slice(0, 10) }),
    );
    expect(refused.statusCode).toBe(400);
    expect(fields(refused)).toHaveProperty('purchasedOn');

    const accepted = await create(token, await minimal(token, { purchasedOn: today }));
    expect(accepted.statusCode).toBe(201);
  });

  it('AC-7: refuses a date that is not a real calendar day or not ISO', async () => {
    const { token } = await account('baddate@example.com');

    for (const purchasedOn of ['2026-02-30', '2026-13-01', '08-08-2026', 'yesterday']) {
      const response = await create(token, await minimal(token, { purchasedOn }));

      expect(response.statusCode, purchasedOn).toBe(400);
      expect(fields(response)).toHaveProperty('purchasedOn');
    }
  });

  /**
   * The reason `purchased_on` is read with `to_char` rather than through the Date
   * `pg` builds. That Date sits at LOCAL midnight, so on this machine — UTC+8 —
   * `toISOString().slice(0, 10)` reports the day before, and an expense filed for
   * the 8th would read as the 7th on every screen and in every export.
   */
  it('AC-11: the purchase date survives a round trip in UTC+8', async () => {
    const { token } = await account('roundtrip@example.com');

    const created = await anExpense(token, { purchasedOn: '2026-08-08' });
    expect(created.purchasedOn).toBe('2026-08-08');

    expect((await fetchOne(token, created.id)).json()).toMatchObject({
      purchasedOn: '2026-08-08',
    });

    const [listed] = (await list(token)).json() as Expense[];
    expect(listed!.purchasedOn).toBe('2026-08-08');

    // And the column really does hold that day, independently of how it is read.
    const { rows } = await database.pool.query<{ day: string }>(
      "SELECT to_char(purchased_on, 'YYYY-MM-DD') AS day FROM expenses WHERE id = $1",
      [created.id],
    );
    expect(rows[0]!.day).toBe('2026-08-08');
  });

  /**
   * The test above is a real guard, but only on a machine east of Greenwich:
   * reverting to the Date-based read reproduced `2026-08-07` here and would go on
   * passing in CI, which runs in UTC where local midnight and UTC midnight are
   * the same instant.
   *
   * So the conversion is also asserted structurally, the way `categories.test.ts`
   * asserts migration 0006 still carries its `WHERE NOT EXISTS`. This one fails
   * everywhere.
   */
  it('AC-11: the date is converted in SQL, not through a JavaScript Date', async () => {
    const source = await readFile(
      new URL('../expenses/expenses.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain("to_char(e.purchased_on, 'YYYY-MM-DD')");
    expect(source).not.toMatch(/purchased_on\S*\.toISOString/);
  });

  it('AC-8: uppercases the currency, defaults it to MYR, and checks its shape', async () => {
    const { token } = await account('currency@example.com');

    expect((await anExpense(token, { currency: 'sgd' })).currency).toBe('SGD');
    expect((await anExpense(token)).currency).toBe('MYR');

    for (const currency of ['MY', 'RINGGIT', 'M1R', '']) {
      const response = await create(token, await minimal(token, { currency }));

      expect(response.statusCode, currency).toBe(400);
      expect(fields(response)).toHaveProperty('currency');
    }
  });

  it('AC-8: caps the note at 1000 characters and the text fields at 255', async () => {
    const { token } = await account('lengths@example.com');

    const longNote = await create(
      token,
      await minimal(token, { note: 'x'.repeat(1001) }),
    );
    expect(longNote.statusCode).toBe(400);
    expect(fields(longNote)).toHaveProperty('note');

    expect((await anExpense(token, { note: 'x'.repeat(1000) })).note).toHaveLength(1000);

    const longMerchant = await create(
      token,
      await minimal(token, { merchantName: 'x'.repeat(256) }),
    );
    expect(longMerchant.statusCode).toBe(400);
    expect(fields(longMerchant)).toHaveProperty('merchantName');
  });

  it('AC-8: trims text and turns blank into null', async () => {
    const { token } = await account('trim@example.com');

    const expense = await anExpense(token, {
      merchantName: '  Master Prawn Mee  ',
      receiptNumber: '   ',
    });

    expect(expense.merchantName).toBe('Master Prawn Mee');
    expect(expense.receiptNumber).toBeNull();
  });

  it('AC-9: an unknown, deleted, or other account\'s category answers one 422', async () => {
    const mine = await account('cat-mine@example.com');
    const theirs = await account('cat-theirs@example.com');

    const theirCategory = await categoryNamed(theirs.token, 'Food');
    const doomed = await categoryNamed(mine.token, 'Medical');
    await app.inject({
      method: 'DELETE',
      url: `/categories/${doomed}`,
      headers: auth(mine.token),
    });

    const unknown = await create(
      mine.token,
      await minimal(mine.token, { categoryId: UNKNOWN_ID }),
    );
    const other = await create(
      mine.token,
      await minimal(mine.token, { categoryId: theirCategory }),
    );
    const deleted = await create(
      mine.token,
      await minimal(mine.token, { categoryId: doomed }),
    );

    expect(unknown.statusCode).toBe(422);
    expect(unknown.json()).toEqual({ error: 'Category not found' });
    expect(other.statusCode).toBe(422);
    expect(other.body).toBe(unknown.body);
    expect(deleted.statusCode).toBe(422);
    expect(deleted.body).toBe(unknown.body);
  });

  it('AC-9: an unknown, deleted, or other account\'s receipt answers one 422', async () => {
    const mine = await account('rec-mine@example.com');
    const theirs = await account('rec-theirs@example.com');

    const theirReceipt = await upload(theirs.token, 'theirs');
    const doomed = await upload(mine.token, 'doomed');
    await app.inject({
      method: 'DELETE',
      url: `/receipts/${doomed}`,
      headers: auth(mine.token),
    });

    const unknown = await create(
      mine.token,
      await minimal(mine.token, { receiptId: UNKNOWN_ID }),
    );
    const other = await create(
      mine.token,
      await minimal(mine.token, { receiptId: theirReceipt }),
    );
    const deleted = await create(
      mine.token,
      await minimal(mine.token, { receiptId: doomed }),
    );

    expect(unknown.statusCode).toBe(422);
    expect(unknown.json()).toEqual({ error: 'Receipt not found' });
    expect(other.body).toBe(unknown.body);
    expect(deleted.body).toBe(unknown.body);
  });

  it('AC-10: a receipt already confirmed answers 409', async () => {
    const { token } = await account('taken@example.com');
    const receiptId = await upload(token);

    await anExpense(token, { receiptId });

    const second = await create(token, await minimal(token, { receiptId }));

    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({
      error: 'Receipt is already attached to an expense',
    });
  });

  it('AC-10: any number of expenses may have no receipt at all', async () => {
    const { token } = await account('noreceipt@example.com');

    await anExpense(token);
    await anExpense(token);
    await anExpense(token);

    expect((await list(token)).json()).toHaveLength(3);
  });
});

describe('GET /expenses', () => {
  it('AC-11: newest purchase first, ties broken by when it was recorded', async () => {
    const { token } = await account('order@example.com');

    const older = await anExpense(token, { purchasedOn: '2026-07-01' });
    const sameDayFirst = await anExpense(token, { purchasedOn: '2026-08-01' });
    const sameDaySecond = await anExpense(token, { purchasedOn: '2026-08-01' });

    const returned = ((await list(token)).json() as Expense[]).map((e) => e.id);

    expect(returned).toEqual([sameDaySecond.id, sameDayFirst.id, older.id]);
  });

  it('AC-11: an account with none returns an empty array', async () => {
    const { token } = await account('empty@example.com');

    const response = await list(token);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it("AC-11: another account's expenses are never listed", async () => {
    const mine = await account('list-mine@example.com');
    const theirs = await account('list-theirs@example.com');

    await anExpense(theirs.token);

    expect((await list(mine.token)).json()).toEqual([]);
  });

  it('AC-12: a category deleted afterwards keeps labelling its expenses', async () => {
    const { token } = await account('label@example.com');
    const categoryId = await categoryNamed(token, 'Food');
    const expense = await anExpense(token, { categoryId });

    await app.inject({
      method: 'DELETE',
      url: `/categories/${categoryId}`,
      headers: auth(token),
    });

    const [listed] = (await list(token)).json() as Expense[];
    expect(listed!.category).toEqual({ id: categoryId, name: 'Food' });

    expect((await fetchOne(token, expense.id)).json()).toMatchObject({
      category: { id: categoryId, name: 'Food' },
    });
  });
});

/**
 * EXP-18 — filtering the list. The contract the CSV and ZIP exports reuse, which
 * is why a wrong answer here would be copied into both.
 */
describe('EXP-18: GET /expenses filters', () => {
  function listWith(token: string, query: string) {
    return app.inject({
      method: 'GET',
      url: `/expenses?${query}`,
      headers: auth(token),
    });
  }

  function dates(response: { json: () => unknown }): string[] {
    return (response.json() as Expense[]).map((expense) => expense.purchasedOn);
  }

  /** The five expenses the issue's manual steps use. */
  async function fixture(token: string) {
    const food = await categoryNamed(token, 'Food');
    const medical = await categoryNamed(token, 'Medical');
    const withReceipt = await upload(token, 'has-one');
    const alsoWithReceipt = await upload(token, 'has-two');

    // Created oldest-first so the ordering assertions exercise real ties.
    await anExpense(token, { purchasedOn: '2026-06-15', categoryId: food });
    await anExpense(token, {
      purchasedOn: '2026-07-01',
      categoryId: medical,
      receiptId: withReceipt,
    });
    await anExpense(token, { purchasedOn: '2026-07-31', categoryId: food });
    await anExpense(token, {
      purchasedOn: '2026-08-01',
      categoryId: medical,
      receiptId: alsoWithReceipt,
    });
    await anExpense(token, { purchasedOn: '2026-08-08', categoryId: food });

    return { food, medical };
  }

  it('AC-1: no parameters returns every expense, newest purchase first', async () => {
    const { token } = await account('filter-none@example.com');
    await fixture(token);

    const response = await app.inject({
      method: 'GET',
      url: '/expenses',
      headers: auth(token),
    });

    expect(response.statusCode).toBe(200);
    expect(dates(response)).toEqual([
      '2026-08-08',
      '2026-08-01',
      '2026-07-31',
      '2026-07-01',
      '2026-06-15',
    ]);
  });

  /**
   * AC-2, and the test this issue most needed. Both bounds are inclusive, so the
   * expenses dated exactly on the boundaries are in and the ones a single day
   * outside are out. A strict comparison passes every other filter test in this
   * file and fails only this one.
   */
  it('AC-2: both date bounds are inclusive', async () => {
    const { token } = await account('filter-boundary@example.com');
    await fixture(token);

    const response = await listWith(token, 'from=2026-07-01&to=2026-07-31');

    expect(response.statusCode).toBe(200);
    expect(dates(response)).toEqual(['2026-07-31', '2026-07-01']);
  });

  it('AC-2: either bound may be given alone', async () => {
    const { token } = await account('filter-open@example.com');
    await fixture(token);

    // Omitting `to` is the documented way to say "everything from here onwards",
    // because AC-7 refuses a future upper bound.
    expect(dates(await listWith(token, 'from=2026-08-01'))).toEqual([
      '2026-08-08',
      '2026-08-01',
    ]);
    expect(dates(await listWith(token, 'to=2026-06-30'))).toEqual(['2026-06-15']);
  });

  it('AC-3: one categoryId, and several as a union', async () => {
    const { token } = await account('filter-category@example.com');
    const { food, medical } = await fixture(token);

    expect(dates(await listWith(token, `categoryId=${medical}`))).toEqual([
      '2026-08-01',
      '2026-07-01',
    ]);
    expect(
      dates(await listWith(token, `categoryId=${medical}&categoryId=${food}`)),
    ).toHaveLength(5);
  });

  it('AC-4: hasReceipt separates documented expenses from undocumented ones', async () => {
    const { token } = await account('filter-receipt@example.com');
    await fixture(token);

    expect(dates(await listWith(token, 'hasReceipt=true'))).toEqual([
      '2026-08-01',
      '2026-07-01',
    ]);
    expect(dates(await listWith(token, 'hasReceipt=false'))).toEqual([
      '2026-08-08',
      '2026-07-31',
      '2026-06-15',
    ]);
  });

  it('AC-5: filters combine with AND', async () => {
    const { token } = await account('filter-combined@example.com');
    const { food } = await fixture(token);

    const response = await listWith(
      token,
      `from=2026-07-01&categoryId=${food}&hasReceipt=false`,
    );

    expect(dates(response)).toEqual(['2026-08-08', '2026-07-31']);
  });

  it('AC-6: a malformed parameter answers 400 naming it', async () => {
    const { token } = await account('filter-malformed@example.com');
    await fixture(token);

    const cases: [string, string][] = [
      ['from=yesterday', 'from'],
      ['from=2026-13-01', 'from'],
      ['to=2026-02-30', 'to'],
      ['to=01-08-2026', 'to'],
      ['categoryId=not-a-uuid', 'categoryId'],
      ['hasReceipt=maybe', 'hasReceipt'],
      ['hasReceipt=1', 'hasReceipt'],
      // An empty value is not a valid date, and treating it as absent would
      // silently widen the result.
      ['from=', 'from'],
    ];

    for (const [query, field] of cases) {
      const response = await listWith(token, query);

      expect(response.statusCode, query).toBe(400);
      expect(fields(response), query).toHaveProperty(field);
    }
  });

  it('AC-7: a future bound is refused on either end', async () => {
    const { token } = await account('filter-future@example.com');

    const from = await listWith(token, 'from=2099-01-01');
    expect(from.statusCode).toBe(400);
    expect(fields(from)).toHaveProperty('from');

    const to = await listWith(token, 'to=2099-01-01');
    expect(to.statusCode).toBe(400);
    expect(fields(to)).toHaveProperty('to');
  });

  it('AC-8: a backwards range answers 400 naming both bounds', async () => {
    const { token } = await account('filter-backwards@example.com');

    const response = await listWith(token, 'from=2026-08-01&to=2026-07-01');

    expect(response.statusCode).toBe(400);
    expect(fields(response)).toHaveProperty('from');
    expect(fields(response)).toHaveProperty('to');
  });

  it('AC-8: an equal from and to is a valid single day', async () => {
    const { token } = await account('filter-oneday@example.com');
    await fixture(token);

    expect(dates(await listWith(token, 'from=2026-07-31&to=2026-07-31'))).toEqual([
      '2026-07-31',
    ]);
  });

  it("AC-9: unknown, deleted, and another account's category all answer one 422", async () => {
    const mine = await account('filter-cat-mine@example.com');
    const theirs = await account('filter-cat-theirs@example.com');
    await fixture(mine.token);

    const theirCategory = await categoryNamed(theirs.token, 'Food');
    const doomed = await categoryNamed(mine.token, 'Shopping');
    await app.inject({
      method: 'DELETE',
      url: `/categories/${doomed}`,
      headers: auth(mine.token),
    });

    const unknown = await listWith(mine.token, `categoryId=${UNKNOWN_ID}`);
    const other = await listWith(mine.token, `categoryId=${theirCategory}`);
    const deleted = await listWith(mine.token, `categoryId=${doomed}`);

    expect(unknown.statusCode).toBe(422);
    expect(unknown.json()).toEqual({ error: 'Category not found' });
    for (const response of [other, deleted]) {
      expect(response.statusCode).toBe(422);
      expect(response.body).toBe(unknown.body);
    }
  });

  it('AC-9: one bad id among several fails the whole request', async () => {
    const { token } = await account('filter-cat-mixed@example.com');
    const { food } = await fixture(token);

    const response = await listWith(
      token,
      `categoryId=${food}&categoryId=${UNKNOWN_ID}`,
    );

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: 'Category not found' });
  });

  it('AC-12: a combination matching nothing answers 200 and an empty array', async () => {
    const { token } = await account('filter-empty@example.com');
    await fixture(token);

    const response = await listWith(token, 'from=2020-01-01&to=2020-12-31');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  /**
   * AC-11. The user scope and the soft-delete predicate are unconditional, so no
   * filter can reach past them. Worth asserting rather than assuming: a filter
   * that widened the scope would be a data leak, not a bug.
   */
  it("AC-11: filters never reach another account's expenses", async () => {
    const mine = await account('filter-scope-mine@example.com');
    const theirs = await account('filter-scope-theirs@example.com');
    await fixture(theirs.token);
    await fixture(mine.token);

    const theirCategories = (await categories(theirs.token)).map((c) => c.id);
    const query = theirCategories.map((id) => `categoryId=${id}`).join('&');

    // Their category ids are not mine, so this is 422 rather than a window into
    // their data.
    expect((await listWith(mine.token, query)).statusCode).toBe(422);

    // And a wide date range still only ever returns mine.
    const wide = await listWith(mine.token, 'from=2026-01-01');
    expect(dates(wide)).toHaveLength(5);
  });

  it('AC-11: soft-deleted expenses stay excluded under every filter', async () => {
    const { token } = await account('filter-deleted@example.com');
    const { food } = await fixture(token);

    const [newest] = (await listWith(token, `categoryId=${food}`)).json() as Expense[];
    await remove(token, newest!.id);

    expect(dates(await listWith(token, `categoryId=${food}`))).toEqual([
      '2026-07-31',
      '2026-06-15',
    ]);
    expect(dates(await listWith(token, 'from=2026-08-01'))).toEqual(['2026-08-01']);
    expect(dates(await listWith(token, 'hasReceipt=false'))).toEqual([
      '2026-07-31',
      '2026-06-15',
    ]);
  });

  it('AC-10: the date filter is applied in SQL, never through a JS Date', async () => {
    const source = await readFile(
      new URL('../expenses/expenses.ts', import.meta.url),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(code).toContain('purchased_on >=');
    expect(code).toContain('purchased_on <=');
    expect(code).toContain('::date');
    expect(code).not.toMatch(/new Date\(/);
  });
});

/**
 * EXP-19 — validation errors that name the actual problem, and query parameters
 * that cannot be silently dropped.
 *
 * Every assertion here is on the exact message string. The existing tests passed
 * against the wrong messages because they only checked that the key was present,
 * which is precisely how these defects survived.
 */
describe('EXP-19: validation reporting', () => {
  function listWith(token: string, query: string) {
    return app.inject({
      method: 'GET',
      url: `/expenses?${query}`,
      headers: auth(token),
    });
  }

  it('AC-1: no route file declares its own fieldErrors', async () => {
    const directory = new URL('../routes/', import.meta.url);
    const files = await readdir(directory);

    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = await readFile(new URL(file, directory), 'utf8');

      expect(source, `${file} declares a local fieldErrors`).not.toMatch(
        /function fieldErrors/,
      );
    }
  });

  it('AC-3: a filter that is not a date names the format, not the future', async () => {
    const { token } = await account('exp19-format@example.com');

    const response = await listWith(token, 'from=yesterday');

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Validation failed',
      fields: { from: 'must be a date as YYYY-MM-DD' },
    });
  });

  it('AC-3: POST reports the same message for a malformed purchasedOn', async () => {
    const { token } = await account('exp19-post@example.com');

    const response = await create(
      token,
      await minimal(token, { purchasedOn: 'yesterday' }),
    );

    expect(response.statusCode).toBe(400);
    expect(fields(response)).toEqual({
      purchasedOn: 'must be a date as YYYY-MM-DD',
    });
  });

  /**
   * AC-4. `2026-13-01` matches the YYYY-MM-DD shape, so the format check passes
   * and the calendar check is the first real failure. Before this change the
   * cross-field range issue arrived last and overwrote it, blaming the range for
   * a month that does not exist.
   */
  it('AC-4: each bound names its own defect', async () => {
    const { token } = await account('exp19-both@example.com');

    const response = await listWith(token, 'from=2026-13-01&to=2026-07-01');

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Validation failed',
      fields: {
        from: 'must be a real calendar date',
        to: 'from must not be later than to',
      },
    });
  });

  it('AC-5: a genuinely backwards range still blames the range on both bounds', async () => {
    const { token } = await account('exp19-range@example.com');

    const response = await listWith(token, 'from=2026-08-01&to=2026-07-01');

    expect(response.statusCode).toBe(400);
    expect(fields(response)).toEqual({
      from: 'from must not be later than to',
      to: 'from must not be later than to',
    });
  });

  it('AC-6: an unrecognised parameter is refused and names itself', async () => {
    const { token } = await account('exp19-unknown@example.com');
    await anExpense(token);

    const response = await listWith(token, 'catgeoryId=whatever');

    // Before this change: 200 with every expense, indistinguishable from a
    // successful narrow query.
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Validation failed',
      fields: { catgeoryId: 'is not a recognised query parameter' },
    });
  });

  it('AC-6: bracket syntax, several unknowns, and unknowns beside valid filters', async () => {
    const { token } = await account('exp19-unknown2@example.com');
    const categoryId = await categoryNamed(token, 'Food');

    const bracket = await listWith(token, `categoryId[]=${categoryId}`);
    expect(bracket.statusCode).toBe(400);
    expect(fields(bracket)).toEqual({
      'categoryId[]': 'is not a recognised query parameter',
    });

    const several = await listWith(token, 'alpha=1&beta=2');
    expect(several.statusCode).toBe(400);
    expect(fields(several)).toEqual({
      alpha: 'is not a recognised query parameter',
      beta: 'is not a recognised query parameter',
    });

    // A valid filter alongside an unknown one is still refused, rather than the
    // unknown being quietly dropped.
    const mixed = await listWith(token, 'from=2026-07-01&nonsense=x');
    expect(mixed.statusCode).toBe(400);
    expect(fields(mixed)).toEqual({
      nonsense: 'is not a recognised query parameter',
    });
  });

  it('AC-6: every documented parameter is still accepted', async () => {
    const { token } = await account('exp19-accepted@example.com');
    const categoryId = await categoryNamed(token, 'Food');

    const response = await listWith(
      token,
      `from=2026-01-01&to=2026-08-01&categoryId=${categoryId}&hasReceipt=false`,
    );

    expect(response.statusCode).toBe(200);
  });

  it('AC-7: a missing or non-object body is keyed body, not an empty string', async () => {
    const { token } = await account('exp19-body@example.com');
    const expense = await anExpense(token);

    const missing = await app.inject({
      method: 'PATCH',
      url: `/expenses/${expense.id}`,
      headers: auth(token),
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({
      error: 'Validation failed',
      fields: { body: 'must be a JSON object' },
    });

    const notAnObject = await app.inject({
      method: 'PATCH',
      url: `/expenses/${expense.id}`,
      headers: { ...auth(token), 'content-type': 'application/json' },
      payload: '"hello"',
    });
    expect(notAnObject.statusCode).toBe(400);
    expect(notAnObject.json()).toEqual({
      error: 'Validation failed',
      fields: { body: 'must be a JSON object' },
    });
  });

  it('AC-8: valid requests are untouched', async () => {
    const { token } = await account('exp19-valid@example.com');
    const created = await anExpense(token, { purchasedOn: '2026-07-15' });

    expect((await listWith(token, 'from=2026-07-01&to=2026-07-31')).statusCode).toBe(200);
    expect((await fetchOne(token, created.id)).statusCode).toBe(200);
    expect(
      (await patch(token, created.id, { totalCents: 999 })).statusCode,
    ).toBe(200);

    // AC-4 of EXP-18 still answers 422, not 400, for a bad reference.
    const badReference = await create(
      token,
      await minimal(token, { categoryId: UNKNOWN_ID }),
    );
    expect(badReference.statusCode).toBe(422);
    expect(badReference.json()).toEqual({ error: 'Category not found' });
  });
});

describe('GET /expenses/:id', () => {
  it('AC-13: returns one expense', async () => {
    const { token } = await account('one@example.com');
    const expense = await anExpense(token);

    const response = await fetchOne(token, expense.id);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expense);
  });

  it('AC-13: unknown, deleted, malformed, and another account\'s all answer one 404', async () => {
    const mine = await account('find-mine@example.com');
    const theirs = await account('find-theirs@example.com');

    const theirExpense = await anExpense(theirs.token);
    const deleted = await anExpense(mine.token);
    await remove(mine.token, deleted.id);

    const unknown = await fetchOne(mine.token, UNKNOWN_ID);
    const other = await fetchOne(mine.token, theirExpense.id);
    const gone = await fetchOne(mine.token, deleted.id);
    const malformed = await fetchOne(mine.token, 'not-a-uuid');

    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'Expense not found' });
    for (const response of [other, gone, malformed]) {
      expect(response.statusCode).toBe(404);
      expect(response.body).toBe(unknown.body);
    }
  });
});

describe('PATCH /expenses/:id', () => {
  it('EXP-40 AC-6: replaces or clears items, while absence preserves them', async () => {
    const { token } = await account('item-patch@example.com');
    const created = await anExpense(token, {
      items: [{ description: 'Old', quantity: null, unitPriceCents: null, lineTotalCents: 100 }],
    });
    const replaced = await patch(token, created.id, {
      items: [{ description: 'New', quantity: '2', unitPriceCents: 200, lineTotalCents: 400 }],
    });
    expect((replaced.json() as Expense).items).toHaveLength(1);
    expect((await patch(token, created.id, { note: 'unchanged items' })).json()).toMatchObject({
      items: [{ description: 'New' }],
    });
    expect((await patch(token, created.id, { items: [] })).json()).toMatchObject({ items: [] });
  });
  it('AC-14: changes only the field it was given', async () => {
    const { token } = await account('patch@example.com');
    const before = await anExpense(token, {
      merchantName: 'Master Prawn Mee',
      subtotalCents: 2580,
      note: 'lunch',
    });

    const response = await patch(token, before.id, { totalCents: 2690 });

    expect(response.statusCode).toBe(200);
    const after = response.json() as Expense;

    expect(after.totalCents).toBe(2690);
    expect(after.merchantName).toBe('Master Prawn Mee');
    expect(after.subtotalCents).toBe(2580);
    expect(after.note).toBe('lunch');
    expect(after.purchasedOn).toBe(before.purchasedOn);
    expect(after.category).toEqual(before.category);
  });

  it('AC-14: an explicit null clears an optional field', async () => {
    const { token } = await account('clear@example.com');
    const expense = await anExpense(token, {
      note: 'lunch',
      receiptNumber: 'INV/1',
      subtotalCents: 2580,
    });

    const response = await patch(token, expense.id, {
      note: null,
      receiptNumber: null,
      subtotalCents: null,
    });

    expect(response.statusCode).toBe(200);
    const after = response.json() as Expense;
    expect(after.note).toBeNull();
    expect(after.receiptNumber).toBeNull();
    expect(after.subtotalCents).toBeNull();
    expect(after.totalCents).toBe(2685);
  });

  it('AC-14: the three required fields cannot be nulled', async () => {
    const { token } = await account('nonull@example.com');
    const expense = await anExpense(token);

    for (const field of ['categoryId', 'totalCents', 'purchasedOn'] as const) {
      const response = await patch(token, expense.id, { [field]: null });

      expect(response.statusCode, field).toBe(400);
      expect(fields(response)).toHaveProperty(field);
    }
  });

  it('AC-14: the same validation applies to a patch', async () => {
    const { token } = await account('patchvalid@example.com');
    const expense = await anExpense(token);

    expect((await patch(token, expense.id, { totalCents: 0 })).statusCode).toBe(400);
    expect((await patch(token, expense.id, { purchasedOn: '2099-01-01' })).statusCode).toBe(
      400,
    );
    expect((await patch(token, expense.id, { currency: 'MY' })).statusCode).toBe(400);
    expect(
      (await patch(token, expense.id, { categoryId: UNKNOWN_ID })).statusCode,
    ).toBe(422);
  });

  it('AC-14: an empty body leaves the expense exactly as it was', async () => {
    const { token } = await account('nochange@example.com');
    const before = await anExpense(token);

    const response = await patch(token, before.id, {});

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(before);
  });

  it('AC-14: unknown, deleted, malformed, and another account\'s answer 404', async () => {
    const mine = await account('patch-mine@example.com');
    const theirs = await account('patch-theirs@example.com');

    const theirExpense = await anExpense(theirs.token);
    const deleted = await anExpense(mine.token);
    await remove(mine.token, deleted.id);

    for (const id of [UNKNOWN_ID, theirExpense.id, deleted.id, 'not-a-uuid']) {
      const response = await patch(mine.token, id, { totalCents: 100 });

      expect(response.statusCode, id).toBe(404);
      expect(response.json()).toEqual({ error: 'Expense not found' });
    }

    // And theirs was not touched.
    expect((await fetchOne(theirs.token, theirExpense.id)).json()).toEqual(theirExpense);
  });

  it('AC-15: attaches, swaps, and detaches a receipt', async () => {
    const { token } = await account('relink@example.com');
    const first = await upload(token, 'first');
    const second = await upload(token, 'second');
    const expense = await anExpense(token);

    expect(expense.receiptId).toBeNull();

    const attached = await patch(token, expense.id, { receiptId: first });
    expect(attached.statusCode).toBe(200);
    expect((attached.json() as Expense).receiptId).toBe(first);

    const swapped = await patch(token, expense.id, { receiptId: second });
    expect(swapped.statusCode).toBe(200);
    expect((swapped.json() as Expense).receiptId).toBe(second);

    const detached = await patch(token, expense.id, { receiptId: null });
    expect(detached.statusCode).toBe(200);
    expect((detached.json() as Expense).receiptId).toBeNull();

    // Freed by the swap, so the first receipt can back something else now.
    const other = await anExpense(token, { receiptId: first });
    expect(other.receiptId).toBe(first);
  });

  it('AC-15: swapping onto a receipt another live expense holds answers 409', async () => {
    const { token } = await account('swapclash@example.com');
    const taken = await upload(token, 'taken');
    await anExpense(token, { receiptId: taken });
    const other = await anExpense(token);

    const response = await patch(token, other.id, { receiptId: taken });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'Receipt is already attached to an expense',
    });

    // The attempt changed nothing.
    expect((await fetchOne(token, other.id)).json()).toMatchObject({ receiptId: null });
  });
});

describe('DELETE /expenses/:id', () => {
  it('AC-16: soft deletes, keeps the row, and refuses a second attempt', async () => {
    const { token } = await account('del@example.com');
    const expense = await anExpense(token);

    expect((await remove(token, expense.id)).statusCode).toBe(204);

    const { rows } = await database.pool.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM expenses WHERE id = $1',
      [expense.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deleted_at).not.toBeNull();

    expect((await remove(token, expense.id)).statusCode).toBe(404);
    expect((await list(token)).json()).toEqual([]);
  });

  it('AC-17: deleting an expense frees its receipt to be confirmed again', async () => {
    const { token } = await account('free@example.com');
    const receiptId = await upload(token);
    const first = await anExpense(token, { receiptId });

    await remove(token, first.id);

    const second = await create(token, await minimal(token, { receiptId }));

    expect(second.statusCode).toBe(201);
    expect((second.json() as Expense).id).not.toBe(first.id);
    expect((second.json() as Expense).receiptId).toBe(receiptId);
  });
});

/**
 * EXP-20 — the streaming CSV export. Shares EXP-18's filter contract, so the
 * assertions below compare against `GET /expenses` wherever the two must agree.
 */
describe('EXP-20: GET /expenses/export.csv', () => {
  function exportWith(token: string, query = '') {
    return app.inject({
      method: 'GET',
      url: `/expenses/export.csv${query === '' ? '' : `?${query}`}`,
      headers: auth(token),
    });
  }

  const HEADER =
    'ID,Purchase Date,Purchase Time,Category,Category ID,Merchant,Merchant Tax ID,'
    + 'Receipt No,Total,Subtotal,Tax,Rounding,Currency,Payment Method,Note,'
    + 'Receipt ID,Created At,Updated At';

  /** The body with its BOM removed, split into records. Empty tail dropped. */
  function records(body: string): string[] {
    return body.replace(/^\uFEFF/, '').split('\r\n').slice(0, -1);
  }

  /** Column 1 of every data row. Only safe where no cell holds a newline. */
  function purchaseDates(body: string): string[] {
    return records(body)
      .slice(1)
      .map((row) => row.split(',')[1] as string);
  }

  it('AC-1: answers 200 as a text/csv attachment', async () => {
    const { token } = await account('csv-basic@example.com');
    await anExpense(token);

    const response = await exportWith(token);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toContain('attachment');
  });

  it('AC-8: opens with a UTF-8 BOM', async () => {
    const { token } = await account('csv-bom@example.com');
    await anExpense(token);

    const response = await exportWith(token);

    expect(response.rawPayload.subarray(0, 3)).toEqual(
      Buffer.from([0xef, 0xbb, 0xbf]),
    );
  });

  it('AC-4: puts the human-readable header row first', async () => {
    const { token } = await account('csv-header@example.com');
    await anExpense(token);

    const response = await exportWith(token);

    expect(records(response.body)[0]).toBe(HEADER);
  });

  it('AC-12: an export matching nothing is the header row alone', async () => {
    const { token } = await account('csv-empty@example.com');

    const response = await exportWith(token);

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(`\uFEFF${HEADER}\r\n`);
  });

  it('AC-3: runs oldest purchase first, the reverse of the list', async () => {
    const { token } = await account('csv-order@example.com');
    const food = await categoryNamed(token, 'Food');

    for (const purchasedOn of ['2026-07-31', '2026-06-15', '2026-08-08']) {
      await anExpense(token, { purchasedOn, categoryId: food });
    }

    const exported = purchaseDates((await exportWith(token)).body);
    const listed = ((await list(token)).json() as Expense[]).map(
      (expense) => expense.purchasedOn,
    );

    expect(exported).toEqual(['2026-06-15', '2026-07-31', '2026-08-08']);
    // The same rows, deliberately the other way round.
    expect(exported).toEqual([...listed].reverse());
  });

  it('AC-5, AC-6: renders amounts as decimals and nulls as empty cells', async () => {
    const { token } = await account('csv-amounts@example.com');
    await anExpense(token, {
      totalCents: 14930,
      subtotalCents: 5,
      taxCents: 0,
      roundingCents: -2,
    });

    const cells = (records((await exportWith(token)).body)[1] as string).split(',');

    // Total, Subtotal, Tax, Rounding, then Currency.
    expect(cells.slice(8, 13)).toEqual(['149.30', '0.05', '0.00', '-0.02', 'MYR']);
    // Purchase Time was never set, so it is empty rather than the text "null".
    expect(cells[2]).toBe('');
  });

  /**
   * AC-7, end to end.
   *
   * The TZ sweep is what makes this test able to fail. The suite is pinned to
   * Asia/Kuala_Lumpur, so a renderer that simply read the process timezone —
   * the exact bug AC-7 forbids — produces the right answer here by luck and the
   * assertion passes. Verified: swapping the implementation for
   * `toLocaleString` left this test green until the sweep was added, and the
   * container runs UTC, where that implementation is wrong.
   *
   * The same shape of blindness as EXP-17, one layer up.
   */
  it('AC-7: renders timestamps in Malaysian time whatever the server runs in', async () => {
    const { token } = await account('csv-time@example.com');
    const expense = await anExpense(token);

    // 18:31Z is 02:31 the NEXT day in Kuala Lumpur, so a UTC render says the 8th.
    await database.pool.query(
      `UPDATE expenses SET created_at = $1, updated_at = $1 WHERE id = $2`,
      ['2026-08-08T18:31:07.412Z', expense.id],
    );

    const original = process.env.TZ;

    try {
      for (const zone of ['UTC', 'America/New_York', 'Asia/Kuala_Lumpur']) {
        process.env.TZ = zone;

        const cells = (records((await exportWith(token)).body)[1] as string).split(',');

        expect(cells[16], zone).toBe('2026-08-09 02:31:07');
        expect(cells[17], zone).toBe('2026-08-09 02:31:07');
      }
    } finally {
      process.env.TZ = original;
    }
  });

  it('AC-9, AC-10: quotes awkward text and neutralises formulas', async () => {
    const { token } = await account('csv-escape@example.com');
    await anExpense(token, {
      merchantName: '=cmd|\'/c calc\'!A1',
      note: 'a, b "quoted" and\na newline',
      purchasedOn: '2026-06-15',
    });
    await anExpense(token, { merchantName: '皇帝虾面', purchasedOn: '2026-06-16' });

    const body = (await exportWith(token)).body;

    // Guarded and quoted, so the spreadsheet treats it as text.
    expect(body).toContain('"\'=cmd|\'/c calc\'!A1"');
    // The note keeps its comma, its doubled quotes and its literal newline.
    expect(body).toContain('"a, b ""quoted"" and\na newline"');
    // Non-Latin text survives the round trip untouched.
    expect(body).toContain('皇帝虾面');
    // One header and two data rows: the embedded newline is a bare LF inside a
    // quoted field, so it does not terminate a record the way CRLF does.
    expect(records(body).length).toBe(3);
    expect(body.split('\r\n').length - 1).toBe(3);
  });

  it('AC-2: applies the same filters as the list, and agrees with it', async () => {
    const { token } = await account('csv-filters@example.com');
    const food = await categoryNamed(token, 'Food');
    const medical = await categoryNamed(token, 'Medical');
    const receipt = await upload(token, 'csv-filter');

    await anExpense(token, { purchasedOn: '2026-06-15', categoryId: food });
    await anExpense(token, {
      purchasedOn: '2026-07-01',
      categoryId: medical,
      receiptId: receipt,
    });
    await anExpense(token, { purchasedOn: '2026-08-08', categoryId: food });

    for (const query of [
      'from=2026-07-01',
      'to=2026-07-01',
      'from=2026-06-15&to=2026-07-01',
      `categoryId=${food}`,
      `categoryId=${food}&categoryId=${medical}`,
      'hasReceipt=true',
      'hasReceipt=false',
      `from=2026-06-01&categoryId=${medical}&hasReceipt=true`,
    ]) {
      const exported = purchaseDates((await exportWith(token, query)).body);
      const listed = (
        (await app.inject({
          method: 'GET',
          url: `/expenses?${query}`,
          headers: auth(token),
        })).json() as Expense[]
      ).map((expense) => expense.purchasedOn);

      expect(exported, query).toEqual([...listed].reverse());
    }
  });

  it('AC-2: answers 400 for a malformed or unrecognised parameter', async () => {
    const { token } = await account('csv-400@example.com');

    for (const [query, field] of [
      ['from=notadate', 'from'],
      ['catgeoryId=x', 'catgeoryId'],
      ['hasReceipt=maybe', 'hasReceipt'],
      ['from=2026-06-01&to=2026-01-01', 'from'],
    ] as const) {
      const response = await exportWith(token, query);

      expect(response.statusCode, query).toBe(400);
      expect(response.json()).toMatchObject({
        error: 'Validation failed',
        fields: expect.objectContaining({ [field]: expect.any(String) }),
      });
    }
  });

  it('AC-2: answers 422 for a category that cannot match', async () => {
    const { token } = await account('csv-422@example.com');
    const food = await categoryNamed(token, 'Food');

    await app.inject({
      method: 'DELETE',
      url: `/categories/${food}`,
      headers: auth(token),
    });

    const response = await exportWith(token, `categoryId=${food}`);

    // 422 rather than an empty CSV: a file of nothing looks exactly like a
    // period with no spending.
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: 'Category not found' });
  });

  it('AC-11: names the download after the range it covers', async () => {
    const { token } = await account('csv-filename@example.com');
    const today = todayInMalaysia();

    for (const [query, expected] of [
      ['from=2026-01-01&to=2026-06-30', 'expenses-2026-01-01-to-2026-06-30.csv'],
      ['from=2026-01-01', `expenses-2026-01-01-to-${today}.csv`],
      ['to=2026-06-30', 'expenses-start-to-2026-06-30.csv'],
      ['', `expenses-start-to-${today}.csv`],
    ] as const) {
      const response = await exportWith(token, query);

      expect(response.headers['content-disposition'], query).toBe(
        `attachment; filename="${expected}"`,
      );
    }
  });

  it('AC-1: refuses a missing or invalid token', async () => {
    const anonymous = await app.inject({
      method: 'GET',
      url: '/expenses/export.csv',
    });
    const garbage = await app.inject({
      method: 'GET',
      url: '/expenses/export.csv',
      headers: { authorization: 'Bearer not.a.token' },
    });

    expect(anonymous.statusCode).toBe(401);
    expect(garbage.statusCode).toBe(401);
  });

  it('AC-16: resolves as its own route, not as an expense id', async () => {
    const { token } = await account('csv-routing@example.com');

    const response = await exportWith(token);

    // The `:id` route would answer 404 with a JSON body for "export.csv".
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
  });

  it('NG-10: leaves soft-deleted expenses out', async () => {
    const { token } = await account('csv-deleted@example.com');
    const kept = await anExpense(token, { purchasedOn: '2026-06-15' });
    const gone = await anExpense(token, { purchasedOn: '2026-06-16' });

    await remove(token, gone.id);

    const body = (await exportWith(token)).body;

    expect(body).toContain(kept.id);
    expect(body).not.toContain(gone.id);
  });

  it('sees only the caller\'s own expenses', async () => {
    const mine = await account('csv-mine@example.com');
    const theirs = await account('csv-theirs@example.com');
    const ours = await anExpense(mine.token, { purchasedOn: '2026-06-15' });
    const foreign = await anExpense(theirs.token, { purchasedOn: '2026-06-15' });

    const body = (await exportWith(mine.token)).body;

    expect(body).toContain(ours.id);
    expect(body).not.toContain(foreign.id);
  });

  /**
   * AC-13. The batching test, and the reason it is written this way.
   *
   * 1,200 rows is more than two 500-row batches, so the cursor is exercised
   * twice. `i % 7` puts ~171 rows on each of seven dates, and a single
   * `generate_series` insert gives them all the same `created_at` to the
   * millisecond — so the ORDER BY falls through to `id`, and any cursor that
   * stops short of the full `(purchased_on, created_at, id)` triple either
   * skips rows or repeats them.
   */
  it('AC-13: exports every row exactly once across many batches', async () => {
    const { token, userId } = await account('csv-batches@example.com');
    const food = await categoryNamed(token, 'Food');

    await database.pool.query(
      `INSERT INTO expenses (user_id, category_id, total_cents, purchased_on)
       SELECT $1, $2, 100 + i, DATE '2020-01-01' + (i % 7)
       FROM generate_series(1, 1200) AS i`,
      [userId, food],
    );

    const rows = records((await exportWith(token)).body).slice(1);
    const ids = rows.map((row) => row.split(',')[0] as string);

    expect(rows.length).toBe(1200);
    expect(new Set(ids).size).toBe(1200);

    // Still fully ordered across every batch boundary.
    const dates = rows.map((row) => row.split(',')[1] as string);
    expect(dates).toEqual([...dates].sort());
  });

  it('AC-13: keeps the filters applied across batches', async () => {
    const { token, userId } = await account('csv-batch-filter@example.com');
    const food = await categoryNamed(token, 'Food');
    const medical = await categoryNamed(token, 'Medical');

    for (const [category, count] of [
      [food, 600],
      [medical, 600],
    ] as const) {
      await database.pool.query(
        `INSERT INTO expenses (user_id, category_id, total_cents, purchased_on)
         SELECT $1, $2, 100 + i, DATE '2020-01-01' + (i % 5)
         FROM generate_series(1, ${count}) AS i`,
        [userId, category],
      );
    }

    const rows = records((await exportWith(token, `categoryId=${food}`)).body).slice(1);

    // A filter dropped on the second batch would return 1,200.
    expect(rows.length).toBe(600);
    expect(rows.every((row) => row.includes(food))).toBe(true);
  });
});

/**
 * EXP-21 — the ZIP export.
 *
 * Every archive here is read back with **yauzl**, a different library from the
 * yazl that wrote it. A ZIP that only its own writer can read is not a ZIP, and
 * asserting on the byte stream would prove nothing about whether Excel, Finder
 * or `unzip` can open it.
 */
describe('EXP-21: GET /expenses/export.zip', () => {
  type Entry = {
    buffer: Buffer;
    compressionMethod: number;
    utf8: boolean;
  };

  function exportZip(token: string, query = '') {
    return app.inject({
      method: 'GET',
      url: `/expenses/export.zip${query === '' ? '' : `?${query}`}`,
      headers: auth(token),
    });
  }

  function readZip(data: Buffer): Promise<Map<string, Entry>> {
    return new Promise((resolve, reject) => {
      fromBuffer(data, { lazyEntries: true }, (error, zip) => {
        if (error || !zip) {
          reject(error ?? new Error('not a zip'));
          return;
        }

        const entries = new Map<string, Entry>();

        zip.on('entry', (entry) => {
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              reject(streamError ?? new Error('no stream'));
              return;
            }

            const chunks: Buffer[] = [];
            stream.on('data', (chunk: Buffer) => chunks.push(chunk));
            stream.on('error', reject);
            stream.on('end', () => {
              entries.set(entry.fileName, {
                buffer: Buffer.concat(chunks),
                compressionMethod: entry.compressionMethod,
                // Bit 11 is the UTF-8 filename flag.
                utf8: (entry.generalPurposeBitFlag & 0x800) !== 0,
              });
              zip.readEntry();
            });
          });
        });
        zip.on('error', reject);
        zip.on('end', () => resolve(entries));
        zip.readEntry();
      });
    });
  }

  async function archiveOf(token: string, query = ''): Promise<Map<string, Entry>> {
    const response = await exportZip(token, query);

    expect(response.statusCode).toBe(200);

    return readZip(response.rawPayload);
  }

  function csvOf(entries: Map<string, Entry>): string[] {
    const csv = entries.get('expenses.csv');

    if (!csv) {
      throw new Error('archive has no expenses.csv');
    }

    return csv.buffer.toString('utf8').replace(/^\uFEFF/, '').split('\r\n').slice(0, -1);
  }

  function imageNames(entries: Map<string, Entry>): string[] {
    return [...entries.keys()].filter((name) => name !== 'expenses.csv').sort();
  }

  /** The `Receipt File` cell of every data row, in order. */
  function receiptCells(entries: Map<string, Entry>): string[] {
    return csvOf(entries)
      .slice(1)
      .map((row) => row.split(',').pop() as string);
  }

  /**
   * Writes bytes to the store and inserts a receipt row with a chosen id, so a
   * test can control the id — needed to force the AC-9 collision, which cannot
   * be provoked through the upload route.
   */
  async function seedReceipt(
    userId: string,
    id: string,
    content: Buffer,
    contentType = 'image/jpeg',
  ): Promise<string> {
    const sha256 = createHash('sha256').update(content).digest('hex');
    const directory = join(root, userId);

    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, sha256), content);
    await database.pool.query(
      `INSERT INTO receipts (id, user_id, sha256, byte_size, content_type)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, userId, sha256, content.length, contentType],
    );

    return sha256;
  }

  it('AC-1: answers 200 as an application/zip attachment', async () => {
    const { token } = await account('zip-basic@example.com');
    await anExpense(token);

    const response = await exportZip(token);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/zip');
    expect(response.headers['content-disposition']).toContain('attachment');
  });

  it('AC-1: refuses a missing or invalid token', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/expenses/export.zip' });
    const garbage = await app.inject({
      method: 'GET',
      url: '/expenses/export.zip',
      headers: { authorization: 'Bearer not.a.token' },
    });

    expect(anonymous.statusCode).toBe(401);
    expect(garbage.statusCode).toBe(401);
  });

  it('AC-3, AC-4, NG-1: the in-ZIP CSV has 19 columns and export.csv still has 18', async () => {
    const { token } = await account('zip-columns@example.com');
    await anExpense(token);

    const zipHeader = (csvOf(await archiveOf(token))[0] as string).split(',');
    const standalone = await app.inject({
      method: 'GET',
      url: '/expenses/export.csv',
      headers: auth(token),
    });
    const csvHeader = standalone.body
      .replace(/^\uFEFF/, '')
      .split('\r\n')[0]
      ?.split(',') as string[];

    expect(csvHeader).toHaveLength(18);
    expect(zipHeader).toHaveLength(19);
    // The first 18 are identical and in the same order; only the 19th is new.
    expect(zipHeader.slice(0, 18)).toEqual(csvHeader);
    expect(zipHeader[18]).toBe('Receipt File');
  });

  it('AC-3: keeps the CSV rules — BOM, CRLF, oldest first', async () => {
    const { token } = await account('zip-csv-rules@example.com');
    const food = await categoryNamed(token, 'Food');

    for (const purchasedOn of ['2026-07-31', '2026-06-15', '2026-08-08']) {
      await anExpense(token, { purchasedOn, categoryId: food });
    }

    const csv = (await archiveOf(token)).get('expenses.csv') as Entry;
    const text = csv.buffer.toString('utf8');

    expect(csv.buffer.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(text).toContain('\r\n');
    expect(
      csvOf(await archiveOf(token))
        .slice(1)
        .map((row) => row.split(',')[1]),
    ).toEqual(['2026-06-15', '2026-07-31', '2026-08-08']);
  });

  it('AC-5, AC-6, AC-7, AC-8: names entries by date, merchant and short id', async () => {
    const { token } = await account('zip-names@example.com');
    const receipts = [
      await upload(token, 'latin'),
      await upload(token, 'chinese'),
      await upload(token, 'nameless'),
    ];

    await anExpense(token, {
      purchasedOn: '2025-01-20',
      merchantName: 'Master Prawn Mee',
      receiptId: receipts[0],
    });
    await anExpense(token, {
      purchasedOn: '2026-08-08',
      merchantName: '皇帝虾面',
      receiptId: receipts[1],
    });
    await anExpense(token, { purchasedOn: '2026-06-15', receiptId: receipts[2] });

    const entries = await archiveOf(token);

    expect(imageNames(entries)).toEqual([
      `receipts/2025-01-20_Master-Prawn-Mee_${receipts[0]?.slice(0, 8)}.jpg`,
      `receipts/2026-06-15_unknown_${receipts[2]?.slice(0, 8)}.jpg`,
      `receipts/2026-08-08_皇帝虾面_${receipts[1]?.slice(0, 8)}.jpg`,
    ]);

    // AC-8: without the UTF-8 flag the Chinese name extracts as mojibake.
    for (const entry of entries.values()) {
      expect(entry.utf8).toBe(true);
    }
  });

  it('NG-6: stores the image bytes verbatim', async () => {
    const { token } = await account('zip-bytes@example.com');
    const receiptId = await upload(token, 'verbatim');
    await anExpense(token, { receiptId });

    const entries = await archiveOf(token);
    const image = entries.get(imageNames(entries)[0] as string) as Entry;

    // Byte-for-byte what was uploaded: no re-encoding, no EXIF stripping.
    expect(image.buffer).toEqual(jpeg('verbatim'));
  });

  it('AC-12: stores entries uncompressed', async () => {
    const { token } = await account('zip-stored@example.com');
    const receiptId = await upload(token, 'stored');
    await anExpense(token, { receiptId });

    for (const entry of (await archiveOf(token)).values()) {
      // 0 is stored, 8 is deflate.
      expect(entry.compressionMethod).toBe(0);
    }
  });

  it('AC-13: writes archive-level ZIP64 even for a tiny archive', async () => {
    const { token } = await account('zip64@example.com');
    await anExpense(token);

    const response = await exportZip(token);

    // The Zip64 end-of-central-directory record and its locator. Absent from a
    // plain ZIP, so this fails the moment the format becomes size-dependent.
    expect(response.rawPayload.includes(Buffer.from('PK\x06\x06', 'latin1'))).toBe(true);
    expect(response.rawPayload.includes(Buffer.from('PK\x06\x07', 'latin1'))).toBe(true);
  });

  /**
   * AC-13, the other half — and a compatibility regression guard.
   *
   * Forcing ZIP64 on individual entries made macOS Archive Utility (`ditto`,
   * which Finder uses) extract the first entry, lose sync on the next local
   * header and silently abandon the rest — while Python, `unzip` and yauzl all
   * read the very same archive perfectly. A file that only the owner's own
   * machine mangles is the worst possible failure, so per-entry ZIP64 stays off.
   *
   * Extra field id 0x0001 is the ZIP64 extended-information header. It has no
   * business appearing on a 68-byte receipt.
   */
  it('AC-13: does not force ZIP64 onto individual entries', async () => {
    const { token } = await account('zip64-entries@example.com');
    const receiptId = await upload(token, 'zip64-entry');
    await anExpense(token, { receiptId });

    const payload = (await exportZip(token)).rawPayload;

    // Walk the central directory headers and read each entry's extra field.
    let offset = payload.indexOf(Buffer.from('PK\x01\x02', 'latin1'));
    let checked = 0;

    while (offset !== -1) {
      const nameLength = payload.readUInt16LE(offset + 28);
      const extraLength = payload.readUInt16LE(offset + 30);
      const extra = payload.subarray(
        offset + 46 + nameLength,
        offset + 46 + nameLength + extraLength,
      );

      for (let cursor = 0; cursor + 4 <= extra.length; ) {
        const headerId = extra.readUInt16LE(cursor);

        expect(headerId, 'entry carries a ZIP64 extended-information field').not.toBe(
          0x0001,
        );
        cursor += 4 + extra.readUInt16LE(cursor + 2);
      }

      checked += 1;
      offset = payload.indexOf(Buffer.from('PK\x01\x02', 'latin1'), offset + 1);
    }

    // The CSV and the image, so the walk above actually inspected something.
    expect(checked).toBe(2);
  });

  it('AC-9: suffixes an entry whose name would collide', async () => {
    const { token, userId } = await account('zip-collision@example.com');
    const food = await categoryNamed(token, 'Food');

    // Two receipt ids sharing their first eight characters, on the same date
    // with the same merchant — the only way the name can actually repeat.
    const first = 'aaaaaaaa-0000-4000-8000-000000000001';
    const second = 'aaaaaaaa-0000-4000-8000-000000000002';

    await seedReceipt(userId, first, jpeg('collide-one'));
    await seedReceipt(userId, second, jpeg('collide-two'));

    for (const receiptId of [first, second]) {
      await anExpense(token, {
        categoryId: food,
        purchasedOn: '2026-08-08',
        merchantName: 'Same Shop',
        receiptId,
      });
    }

    expect(imageNames(await archiveOf(token))).toEqual([
      'receipts/2026-08-08_Same-Shop_aaaaaaaa-2.jpg',
      'receipts/2026-08-08_Same-Shop_aaaaaaaa.jpg',
    ]);
  });

  it('AC-10, AC-11, NG-2: distinguishes present, MISSING and no receipt', async () => {
    const { token, userId } = await account('zip-missing@example.com');
    const food = await categoryNamed(token, 'Food');

    const presentId = await upload(token, 'present');
    const goneId = 'bbbbbbbb-0000-4000-8000-000000000001';
    const goneSha = await seedReceipt(userId, goneId, jpeg('gone'));

    await anExpense(token, {
      categoryId: food,
      purchasedOn: '2026-06-01',
      receiptId: presentId,
    });
    await anExpense(token, {
      categoryId: food,
      purchasedOn: '2026-06-02',
      receiptId: goneId,
    });
    await anExpense(token, { categoryId: food, purchasedOn: '2026-06-03' });

    // The row survives; only the bytes are gone — a volume restored without its
    // files, which is exactly what EXP-14 was written for.
    await rm(join(root, userId, goneSha));

    const entries = await archiveOf(token);
    const cells = receiptCells(entries);

    expect(cells[0]).toMatch(/^receipts\/2026-06-01_/);
    expect(cells[1]).toBe('MISSING');
    expect(cells[2]).toBe('');
    // All three are distinguishable, and only the present one is in the archive.
    expect(new Set(cells).size).toBe(3);
    expect(imageNames(entries)).toHaveLength(1);

    // NG-2: the file route still answers 503 for the same condition.
    const file = await app.inject({
      method: 'GET',
      url: `/receipts/${goneId}/file`,
      headers: auth(token),
    });
    expect(file.statusCode).toBe(503);
  });

  /**
   * AC-17, and the reason this pair exists.
   *
   * yazl reports failures in two places that `pipeline(outputStream, …)` does
   * not observe, and an unhandled `error` event **terminates the Node process**
   * rather than the download. Both were reproduced before the listeners were
   * added, and both tests below take the whole vitest worker down without them
   * — a crashed worker is the failure signal, which is exactly the severity
   * being guarded against.
   */
  it('AC-17: survives a file that cannot be read once the archive is pumping', async () => {
    const { token, userId } = await account('zip-unreadable@example.com');
    const receiptId = 'dddddddd-0000-4000-8000-000000000001';
    const sha256 = createHash('sha256').update(jpeg('unreadable')).digest('hex');

    // A DIRECTORY where the bytes should be. `fileIsPresent` uses access(R_OK),
    // which succeeds for a directory, so the presence pass calls it present and
    // yazl then fails with "not a file" while pumping — the same code path a
    // file vanishing mid-export takes, but deterministic rather than a race.
    await mkdir(join(root, userId, sha256), { recursive: true });
    await database.pool.query(
      `INSERT INTO receipts (id, user_id, sha256, byte_size, content_type)
       VALUES ($1, $2, $3, $4, 'image/jpeg')`,
      [receiptId, userId, sha256, 68],
    );
    await anExpense(token, { purchasedOn: '2026-06-01', receiptId });

    // The transfer fails rather than completing. Under `inject` that surfaces
    // as a rejection, because destroying light-my-request's mock response
    // propagates the error into its promise; over a real socket the client
    // simply gets a truncated download, which is AC-17's intent either way.
    await expect(exportZip(token)).rejects.toThrow(/not a file/);

    // The point of the test: the process is still here to answer. Without the
    // error listeners this line is never reached, because the unhandled event
    // takes the worker down with it.
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
  });

  it('AC-17: survives the database failing part-way through the CSV', async () => {
    const { token } = await account('zip-db-fails@example.com');
    await anExpense(token, { purchasedOn: '2026-06-01' });

    // The presence pass and the CSV pass each run one page query. Failing the
    // second reproduces a database hiccup after the 200 has been sent, which is
    // the exact scenario AC-17 describes — and it lands on the stream handed to
    // yazl, which the `archive` listener alone does not cover.
    let pageQueries = 0;
    const flaky = {
      ...database,
      pool: {
        ...database.pool,
        query: ((text: string, values: unknown[]) => {
          if (typeof text === 'string' && text.includes('created_at_text')) {
            pageQueries += 1;

            if (pageQueries > 1) {
              return Promise.reject(new Error('pg: connection terminated'));
            }
          }

          return database.pool.query(text, values as never);
        }) as typeof database.pool.query,
      },
    } as Database;

    const failing = buildApp({
      config,
      database: flaky,
      emailTransport: silentTransport,
      extractor: skippingExtractor,
    });
    await failing.ready();

    try {
      // Truncated rather than a well-formed archive that is silently short.
      await expect(
        failing.inject({
          method: 'GET',
          url: '/expenses/export.zip',
          headers: auth(token),
        }),
      ).rejects.toThrow(/connection terminated/);

      // The failure really did land on the second pass, after the 200.
      expect(pageQueries).toBeGreaterThan(1);

      // Still alive — this is the assertion the missing listener defeats.
      const health = await failing.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
    } finally {
      await failing.close();
    }
  });

  it('AC-16: an export matching nothing is a valid archive with the header alone', async () => {
    const { token } = await account('zip-empty@example.com');

    const entries = await archiveOf(token);

    expect(imageNames(entries)).toEqual([]);
    expect(csvOf(entries)).toHaveLength(1);
    expect(csvOf(entries)[0]).toContain('Receipt File');
  });

  it('AC-2: applies the same filters as the CSV export', async () => {
    const { token } = await account('zip-filters@example.com');
    const food = await categoryNamed(token, 'Food');
    const medical = await categoryNamed(token, 'Medical');
    const receiptId = await upload(token, 'zip-filter');

    await anExpense(token, { purchasedOn: '2026-06-15', categoryId: food });
    await anExpense(token, { purchasedOn: '2026-07-01', categoryId: medical, receiptId });
    await anExpense(token, { purchasedOn: '2026-08-08', categoryId: food });

    for (const query of [
      '',
      'from=2026-07-01',
      'from=2026-06-15&to=2026-07-01',
      `categoryId=${food}`,
      'hasReceipt=true',
      'hasReceipt=false',
    ]) {
      const fromZip = csvOf(await archiveOf(token, query));
      const fromCsv = (
        await app.inject({
          method: 'GET',
          url: `/expenses/export.csv${query === '' ? '' : `?${query}`}`,
          headers: auth(token),
        })
      ).body
        .replace(/^\uFEFF/, '')
        .split('\r\n')
        .slice(0, -1);

      // Same rows in the same order; the ZIP's copy carries one extra column.
      expect(fromZip.length, query).toBe(fromCsv.length);
      expect(
        fromZip.slice(1).map((row) => row.split(',')[0]),
        query,
      ).toEqual(fromCsv.slice(1).map((row) => row.split(',')[0]));
    }

    // hasReceipt=false must yield rows but no images.
    expect(imageNames(await archiveOf(token, 'hasReceipt=false'))).toEqual([]);
    expect(imageNames(await archiveOf(token, 'hasReceipt=true'))).toHaveLength(1);
  });

  it('AC-2: answers 400 and 422 before writing anything', async () => {
    const { token } = await account('zip-errors@example.com');
    const food = await categoryNamed(token, 'Food');

    for (const [query, field] of [
      ['from=notadate', 'from'],
      ['catgeoryId=x', 'catgeoryId'],
      ['from=2026-06-01&to=2026-01-01', 'from'],
    ] as const) {
      const response = await exportZip(token, query);

      expect(response.statusCode, query).toBe(400);
      expect(response.headers['content-type'], query).toContain('application/json');
      expect(fields(response)).toHaveProperty(field);
    }

    await app.inject({
      method: 'DELETE',
      url: `/categories/${food}`,
      headers: auth(token),
    });

    const unprocessable = await exportZip(token, `categoryId=${food}`);
    expect(unprocessable.statusCode).toBe(422);
    expect(unprocessable.json()).toEqual({ error: 'Category not found' });
  });

  it('AC-15: names the download after the range it covers', async () => {
    const { token } = await account('zip-filename@example.com');
    const today = todayInMalaysia();

    for (const [query, expected] of [
      ['from=2026-01-01&to=2026-06-30', 'expenses-2026-01-01-to-2026-06-30.zip'],
      ['from=2026-01-01', `expenses-2026-01-01-to-${today}.zip`],
      ['to=2026-06-30', 'expenses-start-to-2026-06-30.zip'],
      ['', `expenses-start-to-${today}.zip`],
    ] as const) {
      const response = await exportZip(token, query);

      expect(response.headers['content-disposition'], query).toBe(
        `attachment; filename="${expected}"`,
      );
    }
  });

  it('sees only the caller\'s own expenses and receipts', async () => {
    const mine = await account('zip-mine@example.com');
    const theirs = await account('zip-theirs@example.com');

    const ours = await upload(mine.token, 'mine');
    const foreign = await upload(theirs.token, 'theirs');
    await anExpense(mine.token, { purchasedOn: '2026-06-15', receiptId: ours });
    await anExpense(theirs.token, { purchasedOn: '2026-06-15', receiptId: foreign });

    const names = imageNames(await archiveOf(mine.token));

    expect(names).toHaveLength(1);
    expect(names[0]).toContain(ours.slice(0, 8));
    expect(names[0]).not.toContain(foreign.slice(0, 8));
  });

  /**
   * AC-14. More than one keyset batch, every entry present exactly once.
   *
   * Seeded straight into the database and the store: 520 uploads through HTTP
   * would dominate the suite's runtime and prove nothing extra about batching.
   */
  it('AC-14: crosses batch boundaries with every entry exactly once', async () => {
    const { token, userId } = await account('zip-batches@example.com');
    const food = await categoryNamed(token, 'Food');
    const total = 520;

    for (let index = 0; index < total; index += 1) {
      const receiptId = `cccccccc-0000-4000-8000-${index.toString().padStart(12, '0')}`;

      await seedReceipt(userId, receiptId, jpeg(`batch-${index}`));
      await database.pool.query(
        `INSERT INTO expenses (user_id, category_id, total_cents, purchased_on, receipt_id)
         VALUES ($1, $2, $3, DATE '2020-01-01' + $4::int, $5)`,
        [userId, food, 100 + index, index % 7, receiptId],
      );
    }

    const entries = await archiveOf(token);
    const names = imageNames(entries);

    expect(names).toHaveLength(total);
    expect(new Set(names).size).toBe(total);
    expect(csvOf(entries)).toHaveLength(total + 1);

    // Every row's cell names an entry that is actually in the archive — the
    // CSV and the images come from two separate passes, so a drift between
    // them would leave a row pointing at nothing.
    const present = new Set(names);
    for (const cell of receiptCells(entries)) {
      expect(present.has(cell)).toBe(true);
    }
  });
});

describe('EXP-34: single-use export download tokens', () => {
  async function mint(token: string): Promise<{ token: string; expiresAt: string }> {
    const response = await app.inject({
      method: 'POST',
      url: '/exports/token',
      headers: auth(token),
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { token: string; expiresAt: string };
  }

  it('AC-1, AC-2, AC-7: stores only a hash and returns a one-minute token', async () => {
    const { token, userId } = await account('download-mint@example.com');
    const created = await mint(token);
    expect(new Date(created.expiresAt).getTime() - Date.now()).toBeGreaterThan(55_000);

    const { rows } = await database.pool.query<{ user_id: string; token_hash: string }>(
      'SELECT user_id, token_hash FROM download_tokens',
    );
    expect(rows).toEqual([{ user_id: userId, token_hash: expect.any(String) }]);
    expect(rows[0]!.token_hash).not.toBe(created.token);
  });

  it('AC-3 to AC-6: accepts a URL token once, strips it before strict validation, and preserves bad filters', async () => {
    const { token } = await account('download-once@example.com');
    await anExpense(token);
    const created = await mint(token);

    const first = await app.inject({
      method: 'GET',
      url: `/expenses/export.csv?token=${encodeURIComponent(created.token)}`,
    });
    expect(first.statusCode).toBe(200);

    const replay = await app.inject({
      method: 'GET',
      url: `/expenses/export.csv?token=${encodeURIComponent(created.token)}`,
    });
    const unknown = await app.inject({ method: 'GET', url: '/expenses/export.csv?token=unknown' });
    expect(replay.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(replay.body).toBe(unknown.body);

    const valid = await mint(token);
    const malformed = await app.inject({
      method: 'GET',
      url: `/expenses/export.csv?token=${encodeURIComponent(valid.token)}&catgeoryId=x`,
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ fields: { catgeoryId: expect.any(String) } });

    const bearerAndUrl = await mint(token);
    const withBearer = await app.inject({
      method: 'GET',
      url: `/expenses/export.zip?token=${encodeURIComponent(bearerAndUrl.token)}`,
      headers: auth(token),
    });
    expect(withBearer.statusCode).toBe(200);

    // The URL token was not consumed by the bearer request, so it remains
    // valid for the browser-style ZIP request.
    const zip = await app.inject({
      method: 'GET',
      url: `/expenses/export.zip?token=${encodeURIComponent(bearerAndUrl.token)}`,
    });
    expect(zip.statusCode).toBe(200);
  });

  it('AC-5: concurrent redemption succeeds exactly once', async () => {
    const { token } = await account('download-race@example.com');
    const created = await mint(token);
    const url = `/expenses/export.csv?token=${encodeURIComponent(created.token)}`;
    const results = await Promise.all(Array.from({ length: 6 }, () => app.inject({ method: 'GET', url })));
    expect(results.filter((result) => result.statusCode === 200)).toHaveLength(1);
    expect(results.filter((result) => result.statusCode === 401)).toHaveLength(5);
  });

  it('AC-6: expired, unknown, and replayed tokens have one indistinguishable 401 body', async () => {
    const { token } = await account('download-expired@example.com');
    const expired = await mint(token);
    await database.pool.query(
      'UPDATE download_tokens SET expires_at = now() - interval \'1 second\' WHERE token_hash = $1',
      [hashDownloadToken(expired.token)],
    );

    const used = await mint(token);
    await app.inject({ method: 'GET', url: `/expenses/export.csv?token=${encodeURIComponent(used.token)}` });
    const responses = await Promise.all([
      app.inject({ method: 'GET', url: `/expenses/export.csv?token=${encodeURIComponent(expired.token)}` }),
      app.inject({ method: 'GET', url: `/expenses/export.csv?token=${encodeURIComponent(used.token)}` }),
      app.inject({ method: 'GET', url: '/expenses/export.csv?token=not-a-token' }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([401, 401, 401]);
    expect(new Set(responses.map((response) => response.body)).size).toBe(1);
  });

  it('AC-8 and NG-2: a token belongs to its owner and cannot authenticate another route', async () => {
    const owner = await account('download-owner@example.com');
    const other = await account('download-other@example.com');
    const ownersExpense = await anExpense(owner.token, { merchantName: 'Owners row' });
    const othersExpense = await anExpense(other.token, { merchantName: 'Other row' });
    const created = await mint(owner.token);

    const exportForOwner = await app.inject({
      method: 'GET',
      url: `/expenses/export.csv?token=${encodeURIComponent(created.token)}`,
    });
    expect(exportForOwner.statusCode).toBe(200);
    expect(exportForOwner.body).toContain(ownersExpense.id);
    expect(exportForOwner.body).not.toContain(othersExpense.id);

    const second = await mint(owner.token);
    const ordinaryRoute = await app.inject({
      method: 'GET',
      url: `/expenses?token=${encodeURIComponent(second.token)}`,
    });
    expect(ordinaryRoute.statusCode).toBe(401);
  });

});

describe('todayInMalaysia', () => {
  /**
   * The whole point of the helper. Just after midnight in Kuala Lumpur it is
   * still the previous day in UTC, so a plain UTC comparison would refuse an
   * expense entered for today.
   */
  it('AC-7: reports the Malaysian day, not the UTC one', () => {
    expect(todayInMalaysia(Date.UTC(2026, 7, 8, 17, 30))).toBe('2026-08-09');
    expect(todayInMalaysia(Date.UTC(2026, 7, 8, 12, 0))).toBe('2026-08-08');
    // 07:59 UTC is 15:59 the same day in Malaysia.
    expect(todayInMalaysia(Date.UTC(2026, 7, 8, 7, 59))).toBe('2026-08-08');
  });
});

describe('authentication and limits', () => {
  it('AC-20: every route refuses a missing or invalid token', async () => {
    const { token } = await account('guard@example.com');
    const expense = await anExpense(token);

    const withoutHeader = [
      await app.inject({ method: 'GET', url: '/expenses' }),
      await app.inject({ method: 'POST', url: '/expenses', payload: {} }),
      await app.inject({ method: 'GET', url: `/expenses/${expense.id}` }),
      await app.inject({
        method: 'PATCH',
        url: `/expenses/${expense.id}`,
        payload: { totalCents: 1 },
      }),
      await app.inject({ method: 'DELETE', url: `/expenses/${expense.id}` }),
    ];

    for (const response of withoutHeader) {
      expect(response.statusCode).toBe(401);
    }

    const garbage = await app.inject({
      method: 'GET',
      url: '/expenses',
      headers: { authorization: 'Bearer not.a.token' },
    });
    expect(garbage.statusCode).toBe(401);

    // AC-20: the guard must not have escaped its scope onto /health.
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);

    // Nothing was changed by any of the refused calls.
    expect((await fetchOne(token, expense.id)).json()).toEqual(expense);
  });

  it('AC-20: expense routes are not subject to the auth 10/min budget', async () => {
    const { token } = await account('burst@example.com');

    const responses = [];
    for (let index = 0; index < 15; index += 1) {
      responses.push(await list(token));
    }

    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
  });
});
