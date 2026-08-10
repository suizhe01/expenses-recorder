/**
 * EXP-16 / AC-1 to AC-3 — the expense record.
 *
 * This is the table the whole archive exists for: a category, an amount, a
 * date, and optionally the receipt that proves it. Everything a tax invoice
 * prints is copied here at confirm time rather than read back through
 * `receipt_extractions` (NG-4), so an expense is a standalone record — editing
 * it never disturbs what the model actually read, and a cash spend with no
 * paper is just as valid a row as a photographed one.
 *
 * Money is integer cents, never floats and never `numeric`, matching
 * `receipt_extractions`. `rounding_cents` is signed because Malaysian receipts
 * round to the nearest 5 sen in either direction. The total is authoritative:
 * nothing here reconciles it against subtotal + tax + rounding (NG-3), because
 * a receipt may carry a service charge or discount line this schema has no
 * column for.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.createTable('expenses', {
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
    // AC-2. Deliberately NO ACTION — the FK default — rather than RESTRICT.
    //
    // Categories are only ever soft-deleted, so in normal operation nothing
    // removes the parent row. The one case that does is deleting a user, which
    // cascades to categories, receipts AND expenses in a single statement.
    // RESTRICT is checked immediately, row by row, and would fail depending on
    // the order the cascade happens to delete in; NO ACTION defers its check to
    // the end of the statement, by which point the referencing expense is gone
    // too and there is nothing to complain about.
    //
    // This looks like an oversight. It is not — do not "tighten" it.
    category_id: {
      type: 'uuid',
      notNull: true,
      references: 'categories',
    },
    // Null for a manual entry: an expense may exist with no photograph at all.
    // NO ACTION here for the same reason as above.
    receipt_id: {
      type: 'uuid',
      notNull: false,
      references: 'receipts',
    },
    // `date`, not `timestamptz`. A purchase happened on a calendar day in
    // Malaysia; storing an instant would drag a timezone into every comparison
    // and make a 9pm spend land on the following day in UTC.
    purchased_on: {
      type: 'date',
      notNull: true,
    },
    // Separate and optional, because plenty of receipts print no time.
    purchased_at_time: {
      type: 'time',
      notNull: false,
    },
    total_cents: {
      type: 'integer',
      notNull: true,
    },
    subtotal_cents: {
      type: 'integer',
      notNull: false,
    },
    tax_cents: {
      type: 'integer',
      notNull: false,
    },
    // Signed on purpose; see the note above.
    rounding_cents: {
      type: 'integer',
      notNull: false,
    },
    // Stored per expense so a receipt from Singapore or Bangkok records
    // honestly. There is no conversion anywhere (NG-5) — this is a label on the
    // amount, not an instruction to a rate table.
    currency: {
      type: 'text',
      notNull: true,
      default: 'MYR',
    },
    merchant_name: {
      type: 'text',
      notNull: false,
    },
    merchant_tax_id: {
      type: 'text',
      notNull: false,
    },
    receipt_number: {
      type: 'text',
      notNull: false,
    },
    payment_method: {
      type: 'text',
      notNull: false,
    },
    note: {
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

  // AC-3 and AC-17. At most one LIVE expense per receipt.
  //
  // Partial on two counts. Excluding deleted rows is what frees a receipt when
  // its expense is deleted, so a mis-confirmation can be undone rather than
  // spending the receipt forever — the same reasoning that frees a category
  // name in 0006. Excluding nulls is what allows any number of manual expenses
  // with no receipt at all, which a plain unique index would forbid after the
  // first.
  pgm.createIndex('expenses', 'receipt_id', {
    unique: true,
    where: 'deleted_at IS NULL AND receipt_id IS NOT NULL',
    name: 'expenses_receipt_id_live_unique',
  });

  // AC-11's ordering: every listing is one user's, newest purchase first.
  pgm.createIndex('expenses', ['user_id', { name: 'purchased_on', sort: 'DESC' }], {
    name: 'expenses_user_id_purchased_on_idx',
  });

  // Answering "is this receipt already confirmed?" for AC-18 and AC-19.
  pgm.createIndex('expenses', 'receipt_id', {
    name: 'expenses_receipt_id_idx',
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const down = (pgm) => {
  pgm.dropTable('expenses');
};
