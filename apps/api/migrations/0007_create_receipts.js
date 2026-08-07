/**
 * EXP-13 / AC-1 — receipt images.
 *
 * Only metadata lives here; the bytes sit on disk at
 * `<RECEIPTS_PATH>/<user_id>/<sha256>`. A 7-year archive of photographs has no
 * business inside the database, and keeping them out means a backup is a
 * `pg_dump` plus a directory copy rather than an enormous dump.
 *
 * The unique index is **partial**, covering only rows where `deleted_at IS
 * NULL`, and it is what enforces idempotent upload (AC-6): at most one live
 * receipt per user per content hash, so a retry after a dropped connection
 * cannot create a twin. Because it excludes deleted rows, re-uploading an
 * image you previously deleted creates a fresh receipt (AC-7) rather than
 * colliding forever.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.createTable('receipts', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    // Hex SHA-256 of the file contents. Doubles as the filename on disk, so a
    // row and its bytes can always be matched up from either direction.
    sha256: {
      type: 'text',
      notNull: true,
    },
    byte_size: {
      type: 'integer',
      notNull: true,
    },
    // Determined by sniffing the file's own signature, never from the
    // client-declared header (AC-3).
    content_type: {
      type: 'text',
      notNull: true,
    },
    // Provenance only. Never used to build a path — a filename from a client
    // is untrusted input.
    original_filename: {
      type: 'text',
      notNull: false,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    deleted_at: {
      type: 'timestamptz',
      notNull: false,
    },
  });

  // AC-6: one live receipt per user per hash. See the note above.
  pgm.createIndex('receipts', ['user_id', 'sha256'], {
    unique: true,
    where: 'deleted_at IS NULL',
    name: 'receipts_user_id_sha256_live_unique',
  });

  // Every listing is scoped to one user and ordered by recency.
  pgm.createIndex('receipts', 'user_id');
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const down = (pgm) => {
  // Deliberately leaves the files on disk. A migration rolling back a schema
  // change must not destroy a user's photographs (NG-6).
  pgm.dropTable('receipts');
};
