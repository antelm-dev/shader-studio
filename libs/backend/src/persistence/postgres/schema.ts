import { index, integer, jsonb, pgTable, primaryKey, text, customType } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
  fromDriver: (value) => new Uint8Array(value),
  toDriver: (value) => Buffer.from(value),
});

/**
 * The PostgreSQL schema used by the server.
 *
 * Keep column names explicit: the existing installation predates Drizzle and
 * its migrations already created these tables. The schema is therefore both a
 * typed query model and the source of truth for future server-side relations.
 */
export const shaders = pgTable('shaders', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  author: text('author'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  revision: integer('revision').notNull(),
  projectJson: jsonb('project_json').notNull(),
  controlsJson: jsonb('controls_json').notNull(),
  renderJson: jsonb('render_json').notNull(),
  channelsJson: jsonb('channels_json').notNull(),
});

export const presets = pgTable(
  'presets',
  {
    shaderId: text('shader_id')
      .notNull()
      .references(() => shaders.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    name: text('name').notNull(),
    createdAt: text('created_at').notNull(),
    valuesJson: jsonb('values_json').notNull(),
    renderJson: jsonb('render_json'),
  },
  (table) => [
    primaryKey({ columns: [table.shaderId, table.id] }),
    index('idx_presets_shader').on(table.shaderId),
  ],
);

export const assets = pgTable(
  'assets',
  {
    shaderId: text('shader_id')
      .notNull()
      .references(() => shaders.id, { onDelete: 'cascade' }),
    assetKey: text('asset_key').notNull(),
    extension: text('extension').notNull(),
    width: integer('width'),
    height: integer('height'),
    updatedAt: text('updated_at').notNull(),
    data: bytea('data').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.shaderId, table.assetKey] }),
    index('idx_assets_shader').on(table.shaderId),
  ],
);

export const storageMetadata = pgTable('storage_metadata', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const postgresSchema = {
  assets,
  presets,
  shaders,
  storageMetadata,
};
