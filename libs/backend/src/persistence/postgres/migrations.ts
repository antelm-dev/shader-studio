import type { Migration } from '../migration-runner';

/**
 * Versioned PostgreSQL schema. Mirrors the SQLite schema but stores JSON as
 * `jsonb` and binary assets as `bytea`. The `storage_metadata` ledger is
 * bootstrapped by the repository before migrations run (it also holds the
 * `schema_version` these migrations advance), so it is intentionally absent
 * here. Never edit a shipped migration — add a new one.
 */
export const POSTGRES_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    async up(exec) {
      await exec(`
        CREATE TABLE shaders (
          id            text PRIMARY KEY,
          name          text NOT NULL,
          description   text NOT NULL,
          author        text,
          created_at    text NOT NULL,
          updated_at    text NOT NULL,
          revision      integer NOT NULL,
          project_json  jsonb NOT NULL,
          controls_json jsonb NOT NULL,
          render_json   jsonb NOT NULL,
          channels_json jsonb NOT NULL
        );

        CREATE TABLE presets (
          shader_id   text NOT NULL REFERENCES shaders(id) ON DELETE CASCADE,
          id          text NOT NULL,
          name        text NOT NULL,
          created_at  text NOT NULL,
          values_json jsonb NOT NULL,
          render_json jsonb,
          PRIMARY KEY (shader_id, id)
        );

        CREATE TABLE assets (
          shader_id  text NOT NULL REFERENCES shaders(id) ON DELETE CASCADE,
          asset_key  text NOT NULL,
          extension  text NOT NULL,
          width      integer,
          height     integer,
          updated_at text NOT NULL,
          data       bytea NOT NULL,
          PRIMARY KEY (shader_id, asset_key)
        );

        CREATE INDEX idx_presets_shader ON presets(shader_id);
        CREATE INDEX idx_assets_shader ON assets(shader_id);
      `);
    },
  },
];
