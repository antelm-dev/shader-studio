/**
 * The storage contract every SQL engine implements. It is deliberately shaped
 * around the shader domain — insert a shader, replace its presets, put an asset,
 * bump a revision — rather than exposing raw SQL. All the logic that decides
 * *what* to write lives one level up, in `ShaderLibrary`; a repository only
 * knows how to persist and fetch the rows the library hands it, and how to run a
 * transaction so a shader and its dependents move together.
 *
 * Row DTOs carry pre-serialized JSON (`*_json`) exactly as it is stored, so the
 * engines never need to know the project/controls/render/channels shapes. The
 * library owns every conversion between these rows and the public model.
 */

/** The four channel slots plus the preview, as stored in the `assets` table. */
export type AssetKey = 'thumbnail' | 'texture:0' | 'texture:1' | 'texture:2' | 'texture:3';

export const TEXTURE_ASSET_KEYS = [
  'texture:0',
  'texture:1',
  'texture:2',
  'texture:3',
] as const satisfies readonly AssetKey[];

export const THUMBNAIL_ASSET_KEY: AssetKey = 'thumbnail';

export function textureAssetKey(channel: number): AssetKey {
  return `texture:${channel}` as AssetKey;
}

/** A `shaders` row. `project_json` is the source of truth; fragment/vertex are derived. */
export interface ShaderRow {
  id: string;
  name: string;
  description: string;
  author: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
  projectJson: string;
  controlsJson: string;
  renderJson: string;
  channelsJson: string;
}

/** The mutable columns of a shader — everything an update may rewrite except id/createdAt/revision. */
export interface ShaderMutableFields {
  name: string;
  description: string;
  author: string | null;
  updatedAt: string;
  projectJson: string;
  controlsJson: string;
  renderJson: string;
  channelsJson: string;
}

export interface PresetRow {
  id: string;
  name: string;
  createdAt: string;
  valuesJson: string;
  renderJson: string | null;
}

/** Asset metadata without the bytes — enough to describe presence and dimensions. */
export interface AssetMeta {
  key: AssetKey;
  extension: string;
  width: number | null;
  height: number | null;
  updatedAt: string;
}

export interface StoredAsset extends AssetMeta {
  data: Uint8Array;
}

/** A shader and its dependents as they exist in the database, bytes excluded. */
export interface StoredShader {
  row: ShaderRow;
  presets: PresetRow[];
  /** Metadata for every asset the shader has; bytes fetched separately via `loadAsset`. */
  assets: AssetMeta[];
}

/** A lightweight listing row — no project/render/channels JSON, no asset bytes. */
export interface ShaderSummaryRow {
  id: string;
  name: string;
  description: string;
  updatedAt: string;
  controlCount: number;
  presetCount: number;
  thumbnail: { extension: string; updatedAt: string } | null;
}

/**
 * The operations available inside a transaction. Every method runs on the one
 * connection the surrounding `transaction()` holds, so a shader, its presets and
 * its assets commit or roll back as a unit.
 */
export interface ShaderTx {
  listIds(): Promise<string[]>;
  loadShader(id: string): Promise<StoredShader | null>;
  loadAsset(id: string, key: AssetKey): Promise<StoredAsset | null>;
  insertShader(row: ShaderRow): Promise<void>;
  /**
   * Rewrites the mutable columns and bumps `revision`. When `expectedRevision`
   * is given and no longer matches the stored revision, throws a `conflict`
   * `StorageError` rather than clobbering a concurrent write. Returns the new
   * revision.
   */
  updateShader(id: string, fields: ShaderMutableFields, expectedRevision?: number): Promise<number>;
  deleteShader(id: string): Promise<boolean>;
  replacePresets(shaderId: string, presets: PresetRow[]): Promise<void>;
  putAsset(shaderId: string, asset: StoredAsset): Promise<void>;
  deleteAsset(shaderId: string, key: AssetKey): Promise<void>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
}

export interface ShaderRepository {
  /** Opens the connection, applies engine pragmas/pool settings, runs migrations. */
  init(): Promise<void>;
  close(): Promise<void>;
  /** Runs `work` inside a single transaction, rolling back if it throws. */
  transaction<T>(work: (tx: ShaderTx) => Promise<T>): Promise<T>;

  // Reads — safe outside a transaction.
  listShaders(): Promise<ShaderSummaryRow[]>;
  loadShader(id: string): Promise<StoredShader | null>;
  loadAsset(id: string, key: AssetKey): Promise<StoredAsset | null>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
}
