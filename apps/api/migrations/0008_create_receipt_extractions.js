/**
 * EXP-15 / AC-1 — what Gemini read from a receipt image.
 *
 * One row per **attempt**, never updated (AC-10). A re-run adds a row, so the
 * first reading of a receipt stays visible years later — which matters for an
 * archive whose whole purpose is producing what you filed at the time. It also
 * means a failure has somewhere to be recorded rather than vanishing.
 *
 * Every extracted field is nullable. A crumpled receipt may not show a tax
 * number, and a failed or skipped attempt has no fields at all.
 *
 * Money is integer cents, never floats (AC-3, and the decision in EXP-5).
 * `rounding_cents` is signed on purpose: Malaysian receipts round the total to
 * the nearest 5 sen in either direction, so it is as often negative as
 * positive.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.createTable('receipt_extractions', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    receipt_id: {
      type: 'uuid',
      notNull: true,
      references: 'receipts',
      onDelete: 'CASCADE',
    },
    // succeeded — the model answered, whether or not it found a receipt.
    // failed    — network, timeout, rate limit, or unusable output.
    // skipped   — no API key configured; no call was made (AC-7).
    status: {
      type: 'text',
      notNull: true,
      check: "status IN ('succeeded', 'failed', 'skipped')",
    },
    model: {
      type: 'text',
      notNull: true,
    },
    prompt_tokens: { type: 'integer', notNull: false },
    output_tokens: { type: 'integer', notNull: false },
    // Millionths of a currency unit, derived from the token counts and a rate
    // constant in the code. An estimate: Google's prices change and this row is
    // historical, so the token counts are the durable truth (AC-1).
    //
    // NG-5: never exposed by any API response. Read it with psql.
    cost_micros: { type: 'integer', notNull: false },
    error: { type: 'text', notNull: false },

    // AC-2 — the extracted fields.
    is_receipt: { type: 'boolean', notNull: false },
    confidence: { type: 'numeric(3, 2)', notNull: false },
    merchant_name: { type: 'text', notNull: false },
    merchant_tax_id: { type: 'text', notNull: false },
    receipt_number: { type: 'text', notNull: false },
    purchased_on: { type: 'date', notNull: false },
    purchased_at_time: { type: 'time', notNull: false },
    subtotal_cents: { type: 'integer', notNull: false },
    tax_cents: { type: 'integer', notNull: false },
    rounding_cents: { type: 'integer', notNull: false },
    total_cents: { type: 'integer', notNull: false },
    currency: { type: 'text', notNull: false },
    payment_method: { type: 'text', notNull: false },

    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  // Every read is "the newest attempt for this receipt".
  pgm.createIndex('receipt_extractions', ['receipt_id', 'created_at']);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const down = (pgm) => {
  pgm.dropTable('receipt_extractions');
};
