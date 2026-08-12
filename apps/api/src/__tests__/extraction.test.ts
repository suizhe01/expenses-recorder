import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { parseConfig, type Config } from '../config.js';
import { createDatabase, type Database } from '../db.js';
import type { EmailTransport } from '../email/transport.js';
import {
  createSkippingExtractor,
  estimateCostMicros,
  parseAmountToCents,
  toFields,
  type ExtractionResult,
  type ReceiptExtractor,
} from '../receipts/extraction.js';

const PASSWORD = 'correcthorsebattery';

let root: string;
let config: Config;
let database: Database;

const silentTransport: EmailTransport = {
  name: 'silent',
  sendVerificationEmail: async () => {},
  sendPasswordResetEmail: async () => {},
};

const succeeded: ExtractionResult = {
  status: 'succeeded',
  fields: {
    isReceipt: true,
    confidence: 0.92,
    merchantName: '99 Speedmart',
    merchantTaxId: 'W10-1234-56789012',
    receiptNumber: 'A-0042',
    purchasedOn: '2026-01-14',
    purchasedAtTime: '13:45:00',
    subtotalCents: 1200,
    taxCents: 72,
    roundingCents: -2,
    totalCents: 1270,
    currency: 'MYR',
    paymentMethod: 'CASH',
    items: [],
  },
  promptTokens: 1180,
  outputTokens: 84,
};

function extractorReturning(result: ExtractionResult): ReceiptExtractor {
  return { model: 'fake-model', extract: async () => result };
}

function jpeg(tag = 'a'): Buffer {
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
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="r.jpg"\r\n` +
          'Content-Type: image/jpeg\r\n\r\n',
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

/** Builds an app with a given extractor, so each test picks its own failure mode. */
async function appWith(extractor: ReceiptExtractor): Promise<FastifyInstance> {
  const app = buildApp({
    config,
    database,
    emailTransport: silentTransport,
    extractor,
  });
  await app.ready();
  return app;
}

async function tokenFor(app: FastifyInstance, email: string): Promise<string> {
  await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password: PASSWORD },
  });
  await database.pool.query('UPDATE users SET email_verified = true WHERE email = $1', [
    email,
  ]);
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });

  return (login.json() as { accessToken: string }).accessToken;
}

function upload(app: FastifyInstance, token: string, content: Buffer) {
  const part = multipart(content);

  return app.inject({
    method: 'POST',
    url: '/receipts',
    headers: { authorization: `Bearer ${token}`, ...part.headers },
    payload: part.payload,
  });
}

function attemptsFor(receiptId: string) {
  return database.pool
    .query('SELECT * FROM receipt_extractions WHERE receipt_id = $1 ORDER BY created_at', [
      receiptId,
    ])
    .then((r) => r.rows as Record<string, unknown>[]);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'exp15-'));
  config = parseConfig({
    ...process.env,
    JWT_SECRET: 'test-secret-at-least-thirty-two-chars',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    LOG_LEVEL: 'silent',
    RECEIPTS_PATH: root,
  });
  database = createDatabase(config);
  await database.pool.query('SELECT 1 FROM receipt_extractions LIMIT 0');
});

afterAll(async () => {
  await database.close();
  await rm(root, { recursive: true, force: true });
});

let app: FastifyInstance | undefined;

beforeEach(async () => {
  await database.pool.query('TRUNCATE users CASCADE');
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('parsing amounts', () => {
  it('AC-3: converts printed decimals to integer cents without floats', () => {
    expect(parseAmountToCents('12.35')).toBe(1235);
    expect(parseAmountToCents('RM 1,234.50')).toBe(123450);
    expect(parseAmountToCents('0.05')).toBe(5);
    expect(parseAmountToCents('7')).toBe(700);
    expect(parseAmountToCents('12.3')).toBe(1230);
  });

  it('AC-3: keeps a negative rounding adjustment negative', () => {
    // Malaysian receipts round to the nearest 5 sen in either direction.
    expect(parseAmountToCents('-0.02')).toBe(-2);
    expect(parseAmountToCents('-1.05')).toBe(-105);
  });

  it('AC-3: refuses anything that is not an amount', () => {
    for (const value of ['', 'N/A', 'abc', null, undefined, {}, '1.2.3']) {
      expect(parseAmountToCents(value)).toBeNull();
    }
  });

  it('AC-3: 0.1 + 0.2 style inputs do not drift', () => {
    // The reason amounts are parsed rather than multiplied by the model.
    expect(parseAmountToCents('0.10')! + parseAmountToCents('0.20')!).toBe(30);
    expect(parseAmountToCents('19.99')).toBe(1999);
  });
});

describe('mapping the model output', () => {
  it('EXP-43 AC-2, AC-3, AC-4: maps one level of components in order and caps them', () => {
    const fields = toFields({
      isReceipt: true,
      items: [
        {
          description: '  Nasi lemak set ', quantity: ' 2 ', unitPrice: 'RM 4.50', lineTotal: '9.00',
          components: [
            { description: ' Sambal ', quantity: ' ', unitPrice: null, lineTotal: null },
            { description: 'Egg', quantity: '1', unitPrice: '0.50', lineTotal: '0.50', components: [{ description: 'ignored' }] },
          ],
        },
        { description: 'Tea', quantity: ' ', unitPrice: null, lineTotal: '1.20' },
      ],
    });

    expect(fields.items).toEqual([
      {
        description: 'Nasi lemak set', quantity: '2', unitPriceCents: 450, lineTotalCents: 900,
        components: [
          { description: 'Sambal', quantity: null, unitPriceCents: null, lineTotalCents: null },
          { description: 'Egg', quantity: '1', unitPriceCents: 50, lineTotalCents: 50 },
        ],
      },
      { description: 'Tea', quantity: null, unitPriceCents: null, lineTotalCents: 120, components: [] },
    ]);
    expect(toFields({ isReceipt: false, items: [{ description: 'discard' }] }).items).toEqual([]);
    expect(toFields({ isReceipt: null }).items).toEqual([]);
    expect(toFields({ isReceipt: true, items: Array.from({ length: 201 }, () => ({})) }).items)
      .toHaveLength(200);
    expect(toFields({
      isReceipt: true,
      items: [{ components: Array.from({ length: 51 }, () => ({ description: 'part' })) }],
    }).items[0]!.components).toHaveLength(50);
  });
  it('AC-13: an image that is not a receipt yields null fields', () => {
    const fields = toFields({
      isReceipt: false,
      confidence: 0.98,
      merchantName: 'should be discarded',
      total: '12.00',
    });

    expect(fields.isReceipt).toBe(false);
    expect(fields.merchantName).toBeNull();
    expect(fields.totalCents).toBeNull();
    expect(fields.confidence).toBe(0.98);
  });

  it('AC-2: empty strings become null rather than empty values', () => {
    const fields = toFields({ isReceipt: true, merchantName: '   ', currency: 'myr' });

    expect(fields.merchantName).toBeNull();
    expect(fields.currency).toBe('MYR');
  });
});

describe('cost estimation', () => {
  it('AC-1: derives micros from token counts', () => {
    expect(estimateCostMicros(1000, 100)).toBe(Math.round(1000 * 0.3 + 100 * 2.5));
    expect(estimateCostMicros(null, null)).toBeNull();
  });
});

describe('POST /receipts with extraction', () => {
  it('AC-4, AC-9: returns the reading inline and never the cost or tokens', async () => {
    app = await appWith(extractorReturning(succeeded));
    const token = await tokenFor(app, 'ok@example.com');

    const response = await upload(app, token, jpeg());

    expect(response.statusCode).toBe(201);
    const body = response.json() as { id: string; extraction: Record<string, unknown> };
    expect(body.extraction).toMatchObject({
      status: 'succeeded',
      merchantName: '99 Speedmart',
      totalCents: 1270,
      roundingCents: -2,
      currency: 'MYR',
    });

    // AC-9: never, on any route.
    for (const forbidden of ['promptTokens', 'outputTokens', 'costMicros', 'cost_micros']) {
      expect(response.body).not.toContain(forbidden);
    }

    // But they are recorded for the developer.
    const [attempt] = await attemptsFor(body.id);
    expect(attempt).toMatchObject({ status: 'succeeded', model: 'fake-model' });
    expect(attempt!.prompt_tokens).toBe(1180);
    expect(attempt!.cost_micros).toBeGreaterThan(0);
  });

  it('EXP-43 AC-6, AC-7: persists nested components and serialises the allowlisted fields', async () => {
    app = await appWith(extractorReturning({
      ...succeeded,
      fields: {
        ...succeeded.fields,
        items: [{
          description: 'Rice set', quantity: '1', unitPriceCents: 500, lineTotalCents: 500,
          components: [{ description: 'Soup', quantity: null, unitPriceCents: null, lineTotalCents: null }],
        }],
      },
    }));
    const token = await tokenFor(app, 'items@example.com');
    const response = await upload(app, token, jpeg());
    const body = response.json() as { id: string; extraction: { items: unknown[] } };

    expect(body.extraction.items).toEqual([
      {
        description: 'Rice set', quantity: '1', unitPriceCents: 500, lineTotalCents: 500,
        components: [{ description: 'Soup', quantity: null, unitPriceCents: null, lineTotalCents: null }],
      },
    ]);
    const { rows } = await database.pool.query<{ items: unknown }>(
      'SELECT items FROM receipt_extractions WHERE receipt_id = $1', [body.id],
    );
    expect(rows[0]!.items).toEqual(body.extraction.items);
  });

  it('AC-9: the list carries the newest reading and no cost', async () => {
    app = await appWith(extractorReturning(succeeded));
    const token = await tokenFor(app, 'list@example.com');
    await upload(app, token, jpeg());

    const response = await app.inject({
      method: 'GET',
      url: '/receipts',
      headers: { authorization: `Bearer ${token}` },
    });

    const [item] = response.json() as { extraction: { merchantName: string } }[];
    expect(item!.extraction.merchantName).toBe('99 Speedmart');
    expect(response.body).not.toContain('cost');
    expect(response.body).not.toContain('Tokens');
  });

  it('AC-6: a thrown error still stores the receipt and returns 201', async () => {
    app = await appWith({
      model: 'fake-model',
      extract: async () => {
        throw new Error('gemini exploded');
      },
    });
    const token = await tokenFor(app, 'throws@example.com');

    const response = await upload(app, token, jpeg());

    expect(response.statusCode).toBe(201);
    const body = response.json() as { id: string };
    expect(body.id).toBeTruthy();

    // The receipt survived; that is the whole point.
    const { rows } = await database.pool.query('SELECT 1 FROM receipts WHERE id = $1', [
      body.id,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('AC-6, AC-12: unusable model output is recorded as failed, not partially stored', async () => {
    app = await appWith(
      extractorReturning({ status: 'failed', error: 'model output was not JSON: <html>' }),
    );
    const token = await tokenFor(app, 'garbage@example.com');

    const response = await upload(app, token, jpeg());

    expect(response.statusCode).toBe(201);
    const body = response.json() as { id: string; extraction: { status: string } };
    expect(body.extraction.status).toBe('failed');

    const [attempt] = await attemptsFor(body.id);
    expect(attempt!.status).toBe('failed');
    expect(attempt!.error).toContain('not JSON');
    // No half-populated row.
    expect(attempt!.merchant_name).toBeNull();
    expect(attempt!.total_cents).toBeNull();
  });

  it('AC-5, AC-6: a hanging extractor does not hold the receipt hostage', async () => {
    // The extractor's own timeout is what bounds this in production; here the
    // point is that a failure result, however it arises, still yields 201.
    app = await appWith(
      extractorReturning({ status: 'failed', error: 'request failed: TimeoutError' }),
    );
    const token = await tokenFor(app, 'slow@example.com');

    const response = await upload(app, token, jpeg());

    expect(response.statusCode).toBe(201);
    const body = response.json() as { id: string; extraction: { status: string } };
    expect(body.extraction.status).toBe('failed');
    expect((await attemptsFor(body.id))[0]!.error).toContain('Timeout');
  });

  it('AC-7: with no key the attempt is skipped, not failed', async () => {
    app = await appWith(createSkippingExtractor('gemini-2.5-flash'));
    const token = await tokenFor(app, 'nokey@example.com');

    const response = await upload(app, token, jpeg());

    expect(response.statusCode).toBe(201);
    const body = response.json() as { id: string; extraction: { status: string } };
    expect(body.extraction.status).toBe('skipped');

    const [attempt] = await attemptsFor(body.id);
    expect(attempt!.status).toBe('skipped');
    expect(attempt!.model).toBe('gemini-2.5-flash');
    expect(attempt!.error).toBeNull();
  });

  it('AC-8, AC-10: re-uploading re-extracts without duplicating the receipt', async () => {
    app = await appWith(extractorReturning(succeeded));
    const token = await tokenFor(app, 'again@example.com');

    const first = await upload(app, token, jpeg());
    const second = await upload(app, token, jpeg());

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);

    const firstId = (first.json() as { id: string }).id;
    expect((second.json() as { id: string }).id).toBe(firstId);

    // One receipt, one file — EXP-13's dedup is untouched.
    const receipts = await database.pool.query('SELECT 1 FROM receipts');
    expect(receipts.rows).toHaveLength(1);

    // Two attempts — the retry path, and the first reading is still there.
    const attempts = await attemptsFor(firstId);
    expect(attempts).toHaveLength(2);
    expect(second.json()).toHaveProperty('extraction.status', 'succeeded');
  });
});
