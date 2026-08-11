import type { Executor } from '../auth/sessions.js';

/** Postgres unique-violation, raised by the partial index on live hashes. */
const UNIQUE_VIOLATION = '23505';

export type ReceiptRow = {
  id: string;
  user_id: string;
  sha256: string;
  byte_size: number;
  content_type: string;
  original_filename: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

export type Receipt = {
  id: string;
  contentType: string;
  byteSize: number;
  originalFilename: string | null;
  createdAt: string;
};

/** AC-2 and AC-8: metadata only. Bytes are served by the file endpoint. */
export function toReceipt(row: ReceiptRow): Receipt {
  return {
    id: row.id,
    contentType: row.content_type,
    byteSize: row.byte_size,
    originalFilename: row.original_filename,
    createdAt: row.created_at.toISOString(),
  };
}

const COLUMNS = `id, user_id, sha256, byte_size, content_type, original_filename,
                 created_at, updated_at, deleted_at`;

/** AC-8. Live receipts only, newest first. */
export async function listReceipts(
  executor: Executor,
  userId: string,
): Promise<ReceiptRow[]> {
  const { rows } = await executor.query<ReceiptRow>(
    `SELECT ${COLUMNS}
     FROM receipts
     WHERE user_id = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC, id DESC`,
    [userId],
  );

  return rows;
}

/**
 * AC-6. The live receipt holding these bytes, if the user already has one.
 *
 * Deliberately excludes soft-deleted rows: a hash that matches only a deleted
 * receipt must produce a new one (AC-7), not resurrect something the user
 * cannot see.
 */
export async function findLiveByHash(
  executor: Executor,
  userId: string,
  sha256: string,
): Promise<ReceiptRow | undefined> {
  const { rows } = await executor.query<ReceiptRow>(
    `SELECT ${COLUMNS}
     FROM receipts
     WHERE user_id = $1 AND sha256 = $2 AND deleted_at IS NULL`,
    [userId, sha256],
  );

  return rows[0];
}

/** AC-9 to AC-11. Scoped by user, so another user's id simply matches nothing. */
export async function findLiveById(
  executor: Executor,
  userId: string,
  id: string,
): Promise<ReceiptRow | undefined> {
  const { rows } = await executor.query<ReceiptRow>(
    `SELECT ${COLUMNS}
     FROM receipts
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId],
  );

  return rows[0];
}

/** EXP-21. What the ZIP export needs to name an entry and find its bytes. */
export type ReceiptFile = {
  id: string;
  sha256: string;
  contentType: string;
  createdAt: Date;
};

/**
 * EXP-21 AC-5 and AC-6. The stored file behind each of the given receipt ids.
 *
 * Batched rather than queried per row, so a page of 500 expenses costs one
 * round-trip instead of 500.
 *
 * **Deliberately not filtered on `deleted_at`.** These ids come from live
 * expenses, and EXP-16's AC-18 answers 409 rather than let a receipt backing an
 * expense be deleted — so a soft-deleted row reaching here means the known
 * check-then-act race did, and the bytes are still on disk untouched. Excluding
 * it would report the image as `MISSING` when it exists and the expense
 * legitimately refers to it, which is the worse answer for an archive whose
 * whole job is producing evidence.
 */
export async function findReceiptFilesByIds(
  executor: Executor,
  userId: string,
  ids: string[],
): Promise<Map<string, ReceiptFile>> {
  if (ids.length === 0) {
    return new Map();
  }

  const { rows } = await executor.query<{
    id: string;
    sha256: string;
    content_type: string;
    created_at: Date;
  }>(
    `SELECT id, sha256, content_type, created_at
     FROM receipts
     WHERE user_id = $1 AND id = ANY($2::uuid[])`,
    [userId, ids],
  );

  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        sha256: row.sha256,
        contentType: row.content_type,
        createdAt: row.created_at,
      },
    ]),
  );
}

export type InsertOutcome =
  | { status: 'created'; receipt: ReceiptRow }
  | { status: 'duplicate' };

/**
 * AC-6. Relies on the partial unique index rather than trusting the earlier
 * `findLiveByHash`, so two uploads of the same bytes arriving together cannot
 * both create a receipt — the loser is reported as a duplicate and its caller
 * returns the winner.
 */
export async function insertReceipt(
  executor: Executor,
  userId: string,
  values: {
    sha256: string;
    byteSize: number;
    contentType: string;
    originalFilename: string | null;
  },
): Promise<InsertOutcome> {
  try {
    const { rows } = await executor.query<ReceiptRow>(
      `INSERT INTO receipts (user_id, sha256, byte_size, content_type, original_filename)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${COLUMNS}`,
      [
        userId,
        values.sha256,
        values.byteSize,
        values.contentType,
        values.originalFilename,
      ],
    );

    return { status: 'created', receipt: rows[0] as ReceiptRow };
  } catch (error) {
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      return { status: 'duplicate' };
    }
    throw error;
  }
}

/**
 * AC-10. Soft only. The file on disk is never touched — a mis-tap must not
 * destroy a record this archive exists to be able to produce (NG-6).
 */
export async function softDeleteReceipt(
  executor: Executor,
  userId: string,
  id: string,
): Promise<{ status: 'deleted' } | { status: 'not-found' }> {
  const { rows } = await executor.query<{ id: string }>(
    `UPDATE receipts
     SET deleted_at = now(), updated_at = now()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [id, userId],
  );

  return rows[0] ? { status: 'deleted' } : { status: 'not-found' };
}
