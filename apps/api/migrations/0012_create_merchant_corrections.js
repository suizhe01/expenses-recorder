/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
export const shorthands = undefined;
/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.createTable('merchant_corrections', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    detected_name: { type: 'text', notNull: true },
    normalized_name: { type: 'text', notNull: true },
    merchant_name: { type: 'text', notNull: true },
    category_id: { type: 'uuid', notNull: true, references: 'categories', onDelete: 'RESTRICT' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('merchant_corrections', ['user_id', 'normalized_name'], { unique: true });
  pgm.createIndex('merchant_corrections', 'user_id');
};
/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const down = (pgm) => pgm.dropTable('merchant_corrections');
