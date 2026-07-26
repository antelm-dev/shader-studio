import type { Migration } from '../migration-runner';

/**
 * Versioned SQLite schema. Each entry is applied once, in order, inside the
 * migration transaction the repository opens. JSON is stored as TEXT and binary
 * assets as BLOB. Never edit an already-shipped migration — add a new one.
 */
export const SQLITE_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up(exec) {
      exec(`
        CREATE TABLE shaders (
          id            TEXT PRIMARY KEY,
          name          TEXT NOT NULL,
          description   TEXT NOT NULL,
          author        TEXT,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL,
          revision      INTEGER NOT NULL,
          project_json  TEXT NOT NULL,
          controls_json TEXT NOT NULL,
          render_json   TEXT NOT NULL,
          channels_json TEXT NOT NULL
        );

        CREATE TABLE presets (
          shader_id   TEXT NOT NULL REFERENCES shaders(id) ON DELETE CASCADE,
          id          TEXT NOT NULL,
          name        TEXT NOT NULL,
          created_at  TEXT NOT NULL,
          values_json TEXT NOT NULL,
          render_json TEXT,
          PRIMARY KEY (shader_id, id)
        );

        CREATE TABLE assets (
          shader_id  TEXT NOT NULL REFERENCES shaders(id) ON DELETE CASCADE,
          asset_key  TEXT NOT NULL,
          extension  TEXT NOT NULL,
          width      INTEGER,
          height     INTEGER,
          updated_at TEXT NOT NULL,
          data       BLOB NOT NULL,
          PRIMARY KEY (shader_id, asset_key)
        );

        CREATE TABLE storage_metadata (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE INDEX idx_presets_shader ON presets(shader_id);
        CREATE INDEX idx_assets_shader ON assets(shader_id);
      `);
    },
  },
];
