/**
 * EXP-40 — line-item snapshots belong both to the immutable extraction attempt
 * and to the editable expense it becomes. JSONB keeps receipt order intact.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  for (const table of ['receipt_extractions', 'expenses']) {
    pgm.addColumn(table, {
      items: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    });
  }
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const down = (pgm) => {
  pgm.dropColumns('receipt_extractions', ['items']);
  pgm.dropColumns('expenses', ['items']);
};
