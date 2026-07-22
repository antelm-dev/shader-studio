/**
 * PostgreSQL persistence via `pg`. Used by the Web/Docker server; the connection
 * string comes from `DATABASE_URL` and never leaves the backend. JSON columns
 * are `jsonb` (selected back `::text` so the library keeps its uniform
 * string-shaped rows), assets are `bytea`. Every shader mutation runs on a
 * dedicated pooled client inside a transaction; migrations run once under an
 * advisory lock so concurrent app instances cannot race the schema.
 */

import { Pool, type PoolClient } from 'pg';

import { StorageError } from '../../library/storage-error';
import { runMigrations } from '../migration-runner';
import {
  type AssetKey,
  type AssetMeta,
  type PresetRow,
  type ShaderMutableFields,
  type ShaderRepository,
  type ShaderRow,
  type ShaderSummaryRow,
  type ShaderTx,
  type StoredAsset,
  type StoredShader,
} from '../shader-repository';
import { POSTGRES_MIGRATIONS } from './migrations';

/** Arbitrary but stable key for the migration advisory lock. */
const MIGRATION_LOCK_KEY = 0x5_4d1_9a70; // "shader" mnemonic

type Queryable = Pick<PoolClient, 'query'>;
type Row = Record<string, unknown>;

export interface PostgresRepositoryOptions {
  connectionString: string;
  maxPoolSize?: number;
  /** Statement/connection timeouts, ms. */
  connectionTimeoutMs?: number;
}

export class PostgresRepository implements ShaderRepository {
  private pool: Pool | null = null;

  constructor(private readonly options: PostgresRepositoryOptions) {}

  async init(): Promise<void> {
    const pool = new Pool({
      connectionString: this.options.connectionString,
      max: this.options.maxPoolSize ?? 10,
      connectionTimeoutMillis: this.options.connectionTimeoutMs ?? 10_000,
    });
    // Surface pool-level errors instead of crashing the process on an idle drop.
    pool.on('error', (error) => console.error('[postgres] idle client error', error));
    this.pool = pool;

    const client = await pool.connect().catch((error: unknown) => {
      throw asStorageError(error, 'Cannot connect to PostgreSQL');
    });
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
      await client.query(
        'CREATE TABLE IF NOT EXISTS storage_metadata (key text PRIMARY KEY, value text NOT NULL)',
      );
      await runMigrations(POSTGRES_MIGRATIONS, {
        getVersion: async () => {
          const result = await client.query(
            "SELECT value FROM storage_metadata WHERE key = 'schema_version'",
          );
          return result.rows.length ? Number(result.rows[0]['value']) : 0;
        },
        setVersion: async (version) => {
          await client.query(
            `INSERT INTO storage_metadata (key, value) VALUES ('schema_version', $1)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
            [String(version)],
          );
        },
        exec: async (sql) => {
          await client.query(sql);
        },
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw asStorageError(error, 'Failed to migrate the PostgreSQL database');
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }

  async transaction<T>(work: (tx: ShaderTx) => Promise<T>): Promise<T> {
    const client = await this.poolOrThrow()
      .connect()
      .catch((error: unknown) => {
        throw asStorageError(error, 'Cannot reach the database');
      });
    try {
      await client.query('BEGIN');
      const result = await work(new PgOps(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw asStorageError(error, 'Database transaction failed');
    } finally {
      client.release();
    }
  }

  listShaders(): Promise<ShaderSummaryRow[]> {
    return new PgOps(this.poolOrThrow()).listShaders();
  }

  loadShader(id: string): Promise<StoredShader | null> {
    return new PgOps(this.poolOrThrow()).loadShader(id);
  }

  loadAsset(id: string, key: AssetKey): Promise<StoredAsset | null> {
    return new PgOps(this.poolOrThrow()).loadAsset(id, key);
  }

  getMeta(key: string): Promise<string | null> {
    return new PgOps(this.poolOrThrow()).getMeta(key);
  }

  setMeta(key: string, value: string): Promise<void> {
    return new PgOps(this.poolOrThrow()).setMeta(key, value);
  }

  private poolOrThrow(): Pool {
    if (!this.pool) throw new StorageError('io', 'The database pool is not open');
    return this.pool;
  }
}

/** Every query, parameterized. Runs on whatever `Queryable` it is given — pool for reads, client in a transaction. */
class PgOps implements ShaderTx {
  constructor(private readonly q: Queryable) {}

  async listShaders(): Promise<ShaderSummaryRow[]> {
    const result = await this.q.query(
      `SELECT s.id, s.name, s.description, s.updated_at,
              s.controls_json::text AS controls_json,
              (SELECT COUNT(*) FROM presets p WHERE p.shader_id = s.id) AS preset_count,
              t.extension AS thumb_ext, t.updated_at AS thumb_updated
       FROM shaders s
       LEFT JOIN assets t ON t.shader_id = s.id AND t.asset_key = 'thumbnail'`,
    );
    return result.rows.map(toSummaryRow);
  }

  async listIds(): Promise<string[]> {
    const result = await this.q.query('SELECT id FROM shaders ORDER BY id');
    return result.rows.map((row) => String(row['id']));
  }

  async loadShader(id: string): Promise<StoredShader | null> {
    const result = await this.q.query(
      `SELECT id, name, description, author, created_at, updated_at, revision,
              project_json::text AS project_json, controls_json::text AS controls_json,
              render_json::text AS render_json, channels_json::text AS channels_json
       FROM shaders WHERE id = $1`,
      [id],
    );
    if (!result.rows.length) return null;

    const presets = await this.q.query(
      `SELECT id, name, created_at, values_json::text AS values_json, render_json::text AS render_json
       FROM presets WHERE shader_id = $1 ORDER BY created_at, id`,
      [id],
    );
    const assets = await this.q.query(
      'SELECT asset_key, extension, width, height, updated_at FROM assets WHERE shader_id = $1',
      [id],
    );

    return {
      row: toShaderRow(result.rows[0]),
      presets: presets.rows.map(toPresetRow),
      assets: assets.rows.map(toAssetMeta),
    };
  }

  async loadAsset(id: string, key: AssetKey): Promise<StoredAsset | null> {
    const result = await this.q.query(
      'SELECT asset_key, extension, width, height, updated_at, data FROM assets WHERE shader_id = $1 AND asset_key = $2',
      [id, key],
    );
    if (!result.rows.length) return null;
    return { ...toAssetMeta(result.rows[0]), data: toBytes(result.rows[0]['data']) };
  }

  async insertShader(row: ShaderRow): Promise<void> {
    try {
      await this.q.query(
        `INSERT INTO shaders (id, name, description, author, created_at, updated_at, revision,
                              project_json, controls_json, render_json, channels_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb)`,
        [
          row.id,
          row.name,
          row.description,
          row.author,
          row.createdAt,
          row.updatedAt,
          row.revision,
          row.projectJson,
          row.controlsJson,
          row.renderJson,
          row.channelsJson,
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new StorageError('conflict', `A shader with id "${row.id}" already exists`);
      }
      throw asStorageError(error, 'Failed to insert the shader');
    }
  }

  async updateShader(
    id: string,
    fields: ShaderMutableFields,
    expectedRevision?: number,
  ): Promise<number> {
    const expected = expectedRevision ?? null;
    const result = await this.q.query(
      `UPDATE shaders SET
         name = $1, description = $2, author = $3, updated_at = $4,
         project_json = $5::jsonb, controls_json = $6::jsonb,
         render_json = $7::jsonb, channels_json = $8::jsonb,
         revision = revision + 1
       WHERE id = $9 AND ($10::int IS NULL OR revision = $10::int)
       RETURNING revision`,
      [
        fields.name,
        fields.description,
        fields.author,
        fields.updatedAt,
        fields.projectJson,
        fields.controlsJson,
        fields.renderJson,
        fields.channelsJson,
        id,
        expected,
      ],
    );

    if (!result.rows.length) {
      const existing = await this.q.query('SELECT 1 FROM shaders WHERE id = $1', [id]);
      if (!existing.rows.length)
        throw new StorageError('not_found', `Shader "${id}" was not found`);
      throw new StorageError(
        'conflict',
        `Shader "${id}" was modified by another write (expected revision ${expectedRevision})`,
      );
    }
    return Number(result.rows[0]['revision']);
  }

  async deleteShader(id: string): Promise<boolean> {
    const result = await this.q.query('DELETE FROM shaders WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async replacePresets(shaderId: string, presets: PresetRow[]): Promise<void> {
    await this.q.query('DELETE FROM presets WHERE shader_id = $1', [shaderId]);
    for (const preset of presets) {
      await this.q.query(
        `INSERT INTO presets (shader_id, id, name, created_at, values_json, render_json)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [shaderId, preset.id, preset.name, preset.createdAt, preset.valuesJson, preset.renderJson],
      );
    }
  }

  async putAsset(shaderId: string, asset: StoredAsset): Promise<void> {
    await this.q.query(
      `INSERT INTO assets (shader_id, asset_key, extension, width, height, updated_at, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (shader_id, asset_key) DO UPDATE SET
         extension = EXCLUDED.extension, width = EXCLUDED.width, height = EXCLUDED.height,
         updated_at = EXCLUDED.updated_at, data = EXCLUDED.data`,
      [
        shaderId,
        asset.key,
        asset.extension,
        asset.width,
        asset.height,
        asset.updatedAt,
        Buffer.from(asset.data),
      ],
    );
  }

  async deleteAsset(shaderId: string, key: AssetKey): Promise<void> {
    await this.q.query('DELETE FROM assets WHERE shader_id = $1 AND asset_key = $2', [
      shaderId,
      key,
    ]);
  }

  async getMeta(key: string): Promise<string | null> {
    const result = await this.q.query('SELECT value FROM storage_metadata WHERE key = $1', [key]);
    return result.rows.length ? String(result.rows[0]['value']) : null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.q.query(
      `INSERT INTO storage_metadata (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    );
  }
}

function toShaderRow(row: Row): ShaderRow {
  return {
    id: String(row['id']),
    name: String(row['name']),
    description: String(row['description']),
    author: row['author'] === null ? null : String(row['author']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
    revision: Number(row['revision']),
    projectJson: String(row['project_json']),
    controlsJson: String(row['controls_json']),
    renderJson: String(row['render_json']),
    channelsJson: String(row['channels_json']),
  };
}

function toPresetRow(row: Row): PresetRow {
  return {
    id: String(row['id']),
    name: String(row['name']),
    createdAt: String(row['created_at']),
    valuesJson: String(row['values_json']),
    renderJson: row['render_json'] === null ? null : String(row['render_json']),
  };
}

function toAssetMeta(row: Row): AssetMeta {
  return {
    key: String(row['asset_key']) as AssetKey,
    extension: String(row['extension']),
    width: row['width'] === null ? null : Number(row['width']),
    height: row['height'] === null ? null : Number(row['height']),
    updatedAt: String(row['updated_at']),
  };
}

function toSummaryRow(row: Row): ShaderSummaryRow {
  return {
    id: String(row['id']),
    name: String(row['name']),
    description: String(row['description']),
    updatedAt: String(row['updated_at']),
    controlCount: countArray(row['controls_json']),
    presetCount: Number(row['preset_count'] ?? 0),
    thumbnail:
      row['thumb_ext'] === null || row['thumb_ext'] === undefined
        ? null
        : { extension: String(row['thumb_ext']), updatedAt: String(row['thumb_updated']) },
  };
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new StorageError('io', 'Stored asset is not binary');
}

function countArray(value: unknown): number {
  if (typeof value !== 'string') return 0;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === '23505';
}

function asStorageError(error: unknown, fallback: string): StorageError {
  if (error instanceof StorageError) return error;
  // Never leak the SQL text, connection string, or driver detail to the client.
  console.error('[postgres]', error);
  return new StorageError('io', fallback);
}
