import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { parseConfig, type Config } from '../config.js';
import { createDatabase, type Database } from '../db.js';
import type { EmailTransport } from '../email/transport.js';
import { detectImageType, ensureStorageReady } from '../receipts/storage.js';

const PASSWORD = 'correcthorsebattery';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

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

/** Real signature bytes, padded so every sample clears the 16-byte sniff window. */
function jpeg(tag = 'a'): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from(`padding-${tag}`.padEnd(32, '.')),
  ]);
}

function png(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('padding'.padEnd(32, '.')),
  ]);
}

function webp(): Buffer {
  return Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0x20, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP'),
    Buffer.from('padding'.padEnd(32, '.')),
  ]);
}

function heic(): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftyp'),
    Buffer.from('heic'),
    Buffer.from('padding'.padEnd(32, '.')),
  ]);
}

function multipart(content: Buffer, filename = 'receipt.jpg', declared = 'image/jpeg') {
  const boundary = `----vitest${randomBytes(8).toString('hex')}`;

  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          `Content-Type: ${declared}\r\n\r\n`,
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'exp13-receipts-'));
  config = parseConfig({
    ...process.env,
    JWT_SECRET: 'test-secret-at-least-thirty-two-chars',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    LOG_LEVEL: 'silent',
    RECEIPTS_PATH: root,
    // Small enough to test the limit without generating megabytes (AC-4).
    MAX_UPLOAD_BYTES: '2048',
  });
  database = createDatabase(config);
  await database.pool.query('SELECT 1 FROM receipts LIMIT 0');
});

afterAll(async () => {
  await database.close();
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await database.pool.query('TRUNCATE users CASCADE');
  app = buildApp({ config, database, emailTransport: silentTransport });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

type Account = { token: string; userId: string };

async function account(email: string): Promise<Account> {
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

function upload(token: string, content: Buffer, filename?: string, declared?: string) {
  const part = multipart(content, filename, declared);

  return app.inject({
    method: 'POST',
    url: '/receipts',
    headers: { ...auth(token), ...part.headers },
    payload: part.payload,
  });
}

function list(token: string) {
  return app.inject({ method: 'GET', url: '/receipts', headers: auth(token) });
}

function fetchFile(token: string, id: string) {
  return app.inject({
    method: 'GET',
    url: `/receipts/${id}/file`,
    headers: auth(token),
  });
}

function remove(token: string, id: string) {
  return app.inject({ method: 'DELETE', url: `/receipts/${id}`, headers: auth(token) });
}

/** Files actually on disk for a user, excluding any temporary leftovers. */
async function storedFiles(userId: string): Promise<string[]> {
  try {
    const entries = await readdir(join(root, userId));
    return entries.filter((name) => !name.startsWith('.tmp-'));
  } catch {
    return [];
  }
}

async function tempFiles(userId: string): Promise<string[]> {
  try {
    const entries = await readdir(join(root, userId));
    return entries.filter((name) => name.startsWith('.tmp-'));
  } catch {
    return [];
  }
}

describe('schema and config', () => {
  it('AC-1: uniqueness is enforced only over live rows', async () => {
    const { rows } = await database.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'receipts' AND indexname = 'receipts_user_id_sha256_live_unique'`,
    );

    expect(rows[0]?.indexdef).toContain('UNIQUE');
    expect(rows[0]?.indexdef).toContain('WHERE (deleted_at IS NULL)');
  });

  it('AC-14: the new variables have defaults and are validated', () => {
    const bare = parseConfig({
      DATABASE_URL: 'postgres://x/y',
      JWT_SECRET: 'test-secret-at-least-thirty-two-chars',
      PUBLIC_BASE_URL: 'http://localhost:3000',
    });

    expect(bare.RECEIPTS_PATH).toBe('./data/receipts');
    expect(bare.MAX_UPLOAD_BYTES).toBe(10_485_760);

    expect(() =>
      parseConfig({
        DATABASE_URL: 'postgres://x/y',
        JWT_SECRET: 'test-secret-at-least-thirty-two-chars',
        PUBLIC_BASE_URL: 'http://localhost:3000',
        MAX_UPLOAD_BYTES: 'not-a-number',
      }),
    ).toThrowError(/MAX_UPLOAD_BYTES/);
  });

  it('AC-16: the storage root is created, and an unusable path fails loudly', async () => {
    const fresh = join(root, 'created', 'on', 'demand');
    await ensureStorageReady(fresh);
    await expect(readdir(fresh)).resolves.toEqual([]);

    // A regular file where a directory must be: cannot be created, so startup
    // must refuse rather than discover it on the first upload.
    const asFile = join(root, 'not-a-directory');
    await writeFile(asFile, 'x');
    await expect(ensureStorageReady(asFile)).rejects.toThrow(/RECEIPTS_PATH/);
  });
});

describe('content sniffing', () => {
  it('AC-3: recognises each accepted format from its signature', () => {
    expect(detectImageType(jpeg())).toBe('image/jpeg');
    expect(detectImageType(png())).toBe('image/png');
    expect(detectImageType(webp())).toBe('image/webp');
    expect(detectImageType(heic())).toBe('image/heic');
  });

  it('AC-3: rejects bytes that are not one of the four', () => {
    expect(detectImageType(Buffer.from('this is plainly not an image at all'))).toBeNull();
    expect(detectImageType(Buffer.from('%PDF-1.7 and then some more bytes'))).toBeNull();
    expect(detectImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe('POST /receipts', () => {
  it('AC-2: stores an upload and returns its metadata', async () => {
    const { token, userId } = await account('up@example.com');

    const response = await upload(token, jpeg(), 'tesco-2026-01-14.jpg');

    expect(response.statusCode).toBe(201);
    const body = response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      contentType: 'image/jpeg',
      originalFilename: 'tesco-2026-01-14.jpg',
    });
    expect(body.id).toBeTruthy();
    expect(body.byteSize).toBe(jpeg().length);

    expect(await storedFiles(userId)).toHaveLength(1);
  });

  it('AC-2, AC-3: accepts all four formats', async () => {
    const { token, userId } = await account('formats@example.com');

    for (const [content, expected] of [
      [jpeg(), 'image/jpeg'],
      [png(), 'image/png'],
      [webp(), 'image/webp'],
      [heic(), 'image/heic'],
    ] as const) {
      const response = await upload(token, content);
      expect(response.statusCode).toBe(201);
      expect((response.json() as { contentType: string }).contentType).toBe(expected);
    }

    expect(await storedFiles(userId)).toHaveLength(4);
  });

  it('AC-3: refuses a disguised file and writes nothing', async () => {
    const { token, userId } = await account('fake@example.com');

    const response = await upload(
      token,
      Buffer.from('plain text pretending to be a photograph'),
      'receipt.jpg',
      'image/jpeg',
    );

    expect(response.statusCode).toBe(415);
    expect(await storedFiles(userId)).toEqual([]);
    expect(await tempFiles(userId)).toEqual([]);

    const { rows } = await database.pool.query('SELECT 1 FROM receipts');
    expect(rows).toHaveLength(0);
  });

  it('AC-4: refuses an upload past the configured limit', async () => {
    const { token, userId } = await account('big@example.com');

    const oversized = Buffer.concat([jpeg(), Buffer.alloc(4096, 0x41)]);
    const response = await upload(token, oversized);

    expect(response.statusCode).toBe(413);
    expect(await storedFiles(userId)).toEqual([]);
    expect(await tempFiles(userId)).toEqual([]);
  });

  it('AC-5: leaves no temporary files behind after a success', async () => {
    const { token, userId } = await account('tidy@example.com');

    await upload(token, jpeg());

    expect(await tempFiles(userId)).toEqual([]);
    expect(await storedFiles(userId)).toHaveLength(1);
  });

  it('AC-5: names the stored file after its content hash', async () => {
    const { token, userId } = await account('hashname@example.com');

    await upload(token, jpeg());

    const [name] = await storedFiles(userId);
    const { rows } = await database.pool.query<{ sha256: string }>(
      'SELECT sha256 FROM receipts WHERE user_id = $1',
      [userId],
    );

    expect(name).toBe(rows[0]!.sha256);
    expect(name).toMatch(/^[0-9a-f]{64}$/);
  });

  it('AC-6: re-uploading the same bytes is idempotent', async () => {
    const { token, userId } = await account('dupe@example.com');

    const first = await upload(token, jpeg());
    const second = await upload(token, jpeg());

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect((second.json() as { id: string }).id).toBe(
      (first.json() as { id: string }).id,
    );

    expect(await storedFiles(userId)).toHaveLength(1);
    const { rows } = await database.pool.query('SELECT 1 FROM receipts WHERE user_id = $1', [
      userId,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('AC-6: deduplication does not span users', async () => {
    const mine = await account('mine@example.com');
    const theirs = await account('theirs@example.com');

    const a = await upload(mine.token, jpeg());
    const b = await upload(theirs.token, jpeg());

    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect((a.json() as { id: string }).id).not.toBe((b.json() as { id: string }).id);

    expect(await storedFiles(mine.userId)).toHaveLength(1);
    expect(await storedFiles(theirs.userId)).toHaveLength(1);
  });

  it('AC-7: re-uploading a deleted image creates a new receipt', async () => {
    const { token, userId } = await account('revive@example.com');

    const first = await upload(token, jpeg());
    const firstId = (first.json() as { id: string }).id;
    await remove(token, firstId);

    const second = await upload(token, jpeg());

    expect(second.statusCode).toBe(201);
    expect((second.json() as { id: string }).id).not.toBe(firstId);

    // One file backs both rows — the name is the hash of the content.
    expect(await storedFiles(userId)).toHaveLength(1);

    const { rows } = await database.pool.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM receipts WHERE user_id = $1 ORDER BY created_at',
      [userId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.deleted_at).not.toBeNull();
    expect(rows[1]!.deleted_at).toBeNull();
  });
});

describe('GET /receipts', () => {
  it('AC-8: lists live receipts newest first', async () => {
    const { token } = await account('listing@example.com');

    await upload(token, jpeg('one'));
    await upload(token, jpeg('two'));

    const response = await list(token);

    expect(response.statusCode).toBe(200);
    const items = response.json() as { createdAt: string }[];
    expect(items).toHaveLength(2);
    expect(new Date(items[0]!.createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(items[1]!.createdAt).getTime(),
    );
  });

  it('AC-8: an account with none returns an empty array', async () => {
    const { token } = await account('nothing@example.com');

    const response = await list(token);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it('AC-8: deleted receipts are excluded', async () => {
    const { token } = await account('hidden@example.com');
    const created = await upload(token, jpeg());
    const { id } = created.json() as { id: string };

    await remove(token, id);

    await expect(list(token).then((r) => r.json())).resolves.toEqual([]);
  });
});

describe('GET /receipts/:id/file', () => {
  it('AC-9: streams the bytes with the sniffed type and private caching', async () => {
    const { token } = await account('stream@example.com');
    const content = png();
    const created = await upload(token, content, 'shot.png', 'application/octet-stream');
    const { id } = created.json() as { id: string };

    const response = await fetchFile(token, id);

    expect(response.statusCode).toBe(200);
    // Sniffed, not the octet-stream the client declared.
    expect(response.headers['content-type']).toContain('image/png');
    expect(response.headers['content-length']).toBe(String(content.length));
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.rawPayload.equals(content)).toBe(true);
  });

  it('AC-9: an unknown id returns 404', async () => {
    const { token } = await account('missing@example.com');

    expect((await fetchFile(token, UNKNOWN_ID)).statusCode).toBe(404);
  });
});

describe('DELETE /receipts/:id', () => {
  it('AC-10: soft deletes and keeps the bytes on disk', async () => {
    const { token, userId } = await account('del@example.com');
    const created = await upload(token, jpeg());
    const { id } = created.json() as { id: string };

    expect((await remove(token, id)).statusCode).toBe(204);

    // The row is marked, the file is untouched.
    const { rows } = await database.pool.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM receipts WHERE id = $1',
      [id],
    );
    expect(rows[0]!.deleted_at).not.toBeNull();
    expect(await storedFiles(userId)).toHaveLength(1);

    expect((await fetchFile(token, id)).statusCode).toBe(404);
    expect((await remove(token, id)).statusCode).toBe(404);
  });
});

describe('ownership', () => {
  it("AC-11: another user's receipt is indistinguishable from one that is absent", async () => {
    const mine = await account('a@example.com');
    const theirs = await account('b@example.com');

    const created = await upload(theirs.token, jpeg());
    const theirId = (created.json() as { id: string }).id;

    const fileTheirs = await fetchFile(mine.token, theirId);
    const fileUnknown = await fetchFile(mine.token, UNKNOWN_ID);
    expect(fileTheirs.statusCode).toBe(404);
    expect(fileTheirs.body).toBe(fileUnknown.body);

    const deleteTheirs = await remove(mine.token, theirId);
    const deleteUnknown = await remove(mine.token, UNKNOWN_ID);
    expect(deleteTheirs.statusCode).toBe(404);
    expect(deleteTheirs.body).toBe(deleteUnknown.body);

    // Their receipt is untouched and their bytes were never served.
    expect(fileTheirs.rawPayload.equals(jpeg())).toBe(false);
    const { rows } = await database.pool.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM receipts WHERE id = $1',
      [theirId],
    );
    expect(rows[0]!.deleted_at).toBeNull();
  });

  it('AC-11: a malformed id answers the same 404', async () => {
    const { token } = await account('malformed@example.com');

    const bad = await remove(token, 'not-a-uuid');
    const unknown = await remove(token, UNKNOWN_ID);

    expect(bad.statusCode).toBe(404);
    expect(bad.body).toBe(unknown.body);
  });
});

describe('authentication', () => {
  it('AC-12: every route refuses a request without a valid token', async () => {
    const { token, userId } = await account('guard@example.com');
    const created = await upload(token, jpeg());
    const { id } = created.json() as { id: string };

    const part = multipart(png());
    const responses = [
      await app.inject({ method: 'GET', url: '/receipts' }),
      await app.inject({
        method: 'POST',
        url: '/receipts',
        headers: part.headers,
        payload: part.payload,
      }),
      await app.inject({ method: 'GET', url: `/receipts/${id}/file` }),
      await app.inject({ method: 'DELETE', url: `/receipts/${id}` }),
    ];

    for (const response of responses) {
      expect(response.statusCode).toBe(401);
    }

    // Nothing was written or removed by any of them.
    expect(await storedFiles(userId)).toHaveLength(1);
    const { rows } = await database.pool.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM receipts WHERE id = $1',
      [id],
    );
    expect(rows[0]!.deleted_at).toBeNull();
  });
});

describe('rate limiting', () => {
  it('AC-13: uploads are capped while listing stays unlimited', async () => {
    const { token } = await account('burst@example.com');

    const codes: number[] = [];
    for (let i = 0; i < 61; i += 1) {
      codes.push((await upload(token, jpeg(`n${i}`))).statusCode);
    }

    expect(codes.slice(0, 60).every((code) => code === 201)).toBe(true);
    expect(codes[60]).toBe(429);

    // Reading is unaffected by the upload budget.
    const reads = [];
    for (let i = 0; i < 20; i += 1) {
      reads.push((await list(token)).statusCode);
    }
    expect(reads.every((code) => code === 200)).toBe(true);
  });
});
