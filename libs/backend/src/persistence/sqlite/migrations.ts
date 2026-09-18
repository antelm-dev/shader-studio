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
  {
    version: 2,
    name: 'shader-ownership',
    up(exec) {
      // SQLite accepts NOT NULL on an added column when it carries a default, so
      // pre-authentication rows are backfilled in place — no table rebuild, and
      // no window in which ownership is nullable. A missing owner is never
      // shorthand for "public": `kind` marks a shared example.
      //
      // A SQLite store belongs to one person by construction (the desktop app,
      // or a developer's machine), so its rows go to the local user and stay
      // visible across the upgrade. The shared Postgres deployment backfills to
      // the system owner instead, and a real account claims them afterwards.
      exec(`
        ALTER TABLE shaders ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'local';
        ALTER TABLE shaders ADD COLUMN kind TEXT NOT NULL DEFAULT 'shader';

        CREATE INDEX idx_shaders_owner_updated ON shaders(owner_user_id, updated_at DESC);
      `);
    },
  },
];
