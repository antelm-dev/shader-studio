/**
 * PostgreSQL persistence via Drizzle's node-postgres adapter. The connection
 * string stays server-side, reads use the pool, and every shader mutation uses
 * one Drizzle transaction.
 *
 * Schema migrations intentionally still use the repository's original ledger:
 * existing installations already track `schema_version` there. Keeping that
 * history avoids a second migration tool treating live tables as uninitialized.
 */

import { and, asc, count, eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';

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
import { assets, postgresSchema, presets, shaders, storageMetadata } from './schema';

/** Arbitrary but stable key for the migration advisory lock. */
const MIGRATION_LOCK_KEY = 0x5_4d1_9a70;

type PostgresDb = NodePgDatabase<typeof postgresSchema>;
type PostgresExecutor = Pick<PostgresDb, 'delete' | 'insert' | 'select' | 'update'>;

export interface PostgresRepositoryOptions {
  connectionString: string;
  maxPoolSize?: number;
  /** Statement/connection timeouts, ms. */
  connectionTimeoutMs?: number;
}

export class PostgresRepository implements ShaderRepository {
  private pool: Pool | null = null;
  private db: PostgresDb | null = null;

  constructor(private readonly options: PostgresRepositoryOptions) {}

  async init(): Promise<void> {
    await this.close();

    const pool = new Pool({
      connectionString: this.options.connectionString,
      max: this.options.maxPoolSize ?? 10,
      connectionTimeoutMillis: this.options.connectionTimeoutMs ?? 10_000,
    });
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
        exec: async (statement) => {
          await client.query(statement);
        },
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.pool = null;
      void pool.end().catch(() => undefined);
      throw asStorageError(error, 'Failed to migrate the PostgreSQL database');
    } finally {
      client.release();
    }

    this.db = drizzle({ client: pool, schema: postgresSchema });
  }

  async close(): Promise<void> {
    const pool = this.pool;
    this.db = null;
    this.pool = null;
    await pool?.end();
  }

  async transaction<T>(work: (tx: ShaderTx) => Promise<T>): Promise<T> {
    try {
      return await this.database().transaction((tx) => work(new PgOps(tx)));
    } catch (error) {
      throw asStorageError(error, 'Database transaction failed');
    }
  }

  listShaders(): Promise<ShaderSummaryRow[]> {
    return new PgOps(this.database()).listShaders();
  }

  loadShader(id: string): Promise<StoredShader | null> {
    return new PgOps(this.database()).loadShader(id);
  }

  loadAsset(id: string, key: AssetKey): Promise<StoredAsset | null> {
    return new PgOps(this.database()).loadAsset(id, key);
  }

  getMeta(key: string): Promise<string | null> {
    return new PgOps(this.database()).getMeta(key);
  }

  setMeta(key: string, value: string): Promise<void> {
    return new PgOps(this.database()).setMeta(key, value);
  }

  private database(): PostgresDb {
    if (!this.db) throw new StorageError('io', 'The database pool is not open');
    return this.db;
  }
}

class PgOps implements ShaderTx {
  constructor(private readonly db: PostgresExecutor) {}

  async listShaders(): Promise<ShaderSummaryRow[]> {
    const thumbnails = alias(assets, 'thumbnail_asset');
    const rows = await this.db
      .select({
        id: shaders.id,
        name: shaders.name,
        description: shaders.description,
        updatedAt: shaders.updatedAt,
        controlsJson: shaders.controlsJson,
        presetCount: count(presets.id),
        thumbExt: thumbnails.extension,
        thumbUpdated: thumbnails.updatedAt,
      })
      .from(shaders)
      .leftJoin(presets, eq(presets.shaderId, shaders.id))
      .leftJoin(
        thumbnails,
        and(eq(thumbnails.shaderId, shaders.id), eq(thumbnails.assetKey, 'thumbnail')),
      )
      .groupBy(
        shaders.id,
        shaders.name,
        shaders.description,
        shaders.updatedAt,
        shaders.controlsJson,
        thumbnails.extension,
        thumbnails.updatedAt,
      );

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      updatedAt: row.updatedAt,
      controlCount: Array.isArray(row.controlsJson) ? row.controlsJson.length : 0,
      presetCount: row.presetCount,
      thumbnail:
        row.thumbExt === null
          ? null
          : { extension: row.thumbExt, updatedAt: required(row.thumbUpdated, 'thumbnail date') },
    }));
  }

  async listIds(): Promise<string[]> {
    const rows = await this.db.select({ id: shaders.id }).from(shaders).orderBy(asc(shaders.id));
    return rows.map((row) => row.id);
  }

  async loadShader(id: string): Promise<StoredShader | null> {
    const [row] = await this.db.select().from(shaders).where(eq(shaders.id, id)).limit(1);
    if (!row) return null;

    const presetRows = await this.db
      .select()
      .from(presets)
      .where(eq(presets.shaderId, id))
      .orderBy(asc(presets.createdAt), asc(presets.id));
    const assetRows = await this.db
      .select({
        assetKey: assets.assetKey,
        extension: assets.extension,
        width: assets.width,
        height: assets.height,
        updatedAt: assets.updatedAt,
      })
      .from(assets)
      .where(eq(assets.shaderId, id));

    return {
      row: {
        id: row.id,
        name: row.name,
        description: row.description,
        author: row.author,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        revision: row.revision,
        projectJson: stringifyJson(row.projectJson),
        controlsJson: stringifyJson(row.controlsJson),
        renderJson: stringifyJson(row.renderJson),
        channelsJson: stringifyJson(row.channelsJson),
      },
      presets: presetRows.map((preset) => ({
        id: preset.id,
        name: preset.name,
        createdAt: preset.createdAt,
        valuesJson: stringifyJson(preset.valuesJson),
        renderJson: preset.renderJson === null ? null : stringifyJson(preset.renderJson),
      })),
      assets: assetRows.map(toAssetMeta),
    };
  }

  async loadAsset(id: string, key: AssetKey): Promise<StoredAsset | null> {
    const [row] = await this.db
      .select()
      .from(assets)
      .where(and(eq(assets.shaderId, id), eq(assets.assetKey, key)))
      .limit(1);
    if (!row) return null;
    return { ...toAssetMeta(row), data: row.data };
  }

  async insertShader(row: ShaderRow): Promise<void> {
    try {
      await this.db.insert(shaders).values({
        id: row.id,
        name: row.name,
        description: row.description,
        author: row.author,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        revision: row.revision,
        projectJson: parseJson(row.projectJson),
        controlsJson: parseJson(row.controlsJson),
        renderJson: parseJson(row.renderJson),
        channelsJson: parseJson(row.channelsJson),
      });
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
    const predicate =
      expectedRevision === undefined
        ? eq(shaders.id, id)
        : and(eq(shaders.id, id), eq(shaders.revision, expectedRevision));
    const [updated] = await this.db
      .update(shaders)
      .set({
        name: fields.name,
        description: fields.description,
        author: fields.author,
        updatedAt: fields.updatedAt,
        projectJson: parseJson(fields.projectJson),
        controlsJson: parseJson(fields.controlsJson),
        renderJson: parseJson(fields.renderJson),
        channelsJson: parseJson(fields.channelsJson),
        revision: sql`${shaders.revision} + 1`,
      })
      .where(predicate)
      .returning({ revision: shaders.revision });

    if (!updated) {
      const [existing] = await this.db
        .select({ revision: shaders.revision })
        .from(shaders)
        .where(eq(shaders.id, id))
        .limit(1);
      if (!existing) throw new StorageError('not_found', `Shader "${id}" was not found`);
      throw new StorageError(
        'conflict',
        `Shader "${id}" was modified by another write (expected revision ${expectedRevision})`,
      );
    }
    return updated.revision;
  }

  async deleteShader(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(shaders)
      .where(eq(shaders.id, id))
      .returning({ id: shaders.id });
    return rows.length > 0;
  }

  async replacePresets(shaderId: string, rows: PresetRow[]): Promise<void> {
    await this.db.delete(presets).where(eq(presets.shaderId, shaderId));
    if (rows.length === 0) return;
    await this.db.insert(presets).values(
      rows.map((row) => ({
        shaderId,
        id: row.id,
        name: row.name,
        createdAt: row.createdAt,
        valuesJson: parseJson(row.valuesJson),
        renderJson: row.renderJson === null ? null : parseJson(row.renderJson),
      })),
    );
  }

  async putAsset(shaderId: string, asset: StoredAsset): Promise<void> {
    await this.db
      .insert(assets)
      .values({
        shaderId,
        assetKey: asset.key,
        extension: asset.extension,
        width: asset.width,
        height: asset.height,
        updatedAt: asset.updatedAt,
        data: asset.data,
      })
      .onConflictDoUpdate({
        target: [assets.shaderId, assets.assetKey],
        set: {
          extension: asset.extension,
          width: asset.width,
          height: asset.height,
          updatedAt: asset.updatedAt,
          data: asset.data,
        },
      });
  }

  async deleteAsset(shaderId: string, key: AssetKey): Promise<void> {
    await this.db
      .delete(assets)
      .where(and(eq(assets.shaderId, shaderId), eq(assets.assetKey, key)));
  }

  async getMeta(key: string): Promise<string | null> {
    const [row] = await this.db
      .select({ value: storageMetadata.value })
      .from(storageMetadata)
      .where(eq(storageMetadata.key, key))
      .limit(1);
    return row?.value ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.db
      .insert(storageMetadata)
      .values({ key, value })
      .onConflictDoUpdate({ target: storageMetadata.key, set: { value } });
  }
}

function toAssetMeta(row: {
  assetKey: string;
  extension: string;
  width: number | null;
  height: number | null;
  updatedAt: string;
}): AssetMeta {
  return {
    key: row.assetKey as AssetKey,
    extension: row.extension,
    width: row.width,
    height: row.height,
    updatedAt: row.updatedAt,
  };
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function required<T>(value: T | null, label: string): T {
  if (value === null) throw new StorageError('io', `Stored ${label} is missing`);
  return value;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    (error as { cause?: { code?: string }; code?: string })?.code === '23505' ||
    (error as { cause?: { code?: string } })?.cause?.code === '23505'
  );
}

function asStorageError(error: unknown, fallback: string): StorageError {
  if (error instanceof StorageError) return error;
  console.error('[postgres]', error);
  return new StorageError('io', fallback);
}
