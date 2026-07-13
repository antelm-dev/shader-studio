/**
 * File-backed persistence for shaders and their presets.
 *
 * On-disk layout, one directory per shader:
 *
 *   <dataDir>/
 *     .seeded                  marker; its presence suppresses re-seeding
 *     shaders/
 *       <id>/
 *         meta.json            name, description, controls, render settings
 *         fragment.glsl        the fragment shader source
 *         vertex.glsl          the vertex shader source
 *         presets.json         { "presets": [ ... ] }
 *         thumbnail.<ext>      the preview the client captured on the last save
 *
 * The id is both the primary key and the directory name, which is why it is
 * validated (`validateId`) before it is ever joined onto a path, and why the
 * join is then re-checked against the root (`shaderDir`). Renaming a shader
 * changes its display name only; the id — and therefore the path — is stable.
 *
 * Writes go through `writeFileAtomic`, and every mutation of a given shader is
 * serialized by `withLock`, so a half-written meta.json is not observable even
 * if two requests race.
 */

import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  DEFAULT_CHANNELS,
  DEFAULT_RENDER,
  DEFAULT_TEXTURE_CHANNEL,
  toPayload,
  toSummary,
  type ImportMode,
  type ImportResult,
  type Preset,
  type RenderSettings,
  type ShaderControl,
  type ShaderMeta,
  type ShaderParams,
  type ShaderPayload,
  type ShaderRecord,
  type ShaderSummary,
  type TextureChannelPayloads,
  type TextureChannels,
  type TextureChannelSettingsPatch,
  type ThumbnailMeta,
  type ThumbnailPayload,
} from '../../shared/model';
import {
  LIMITS,
  sanitizeParams,
  slugify,
  TEXTURE_EXTENSIONS,
  uniqueId,
  validateChannels,
  validateChannelSettingsPatch,
  validateControls,
  validateDescription,
  validateId,
  validateName,
  validatePreset,
  validateRender,
  validateSource,
  validateThumbnailMeta,
} from '../../shared/validate';
import { expect, StorageError } from './storage-error';
import { DEFAULT_VERTEX, TEMPLATE_CONTROLS, TEMPLATE_FRAGMENT } from './templates';
import type { StorageOptions } from './types';

const META_FILE = 'meta.json';
const FRAGMENT_FILE = 'fragment.glsl';
const VERTEX_FILE = 'vertex.glsl';
const PRESETS_FILE = 'presets.json';
const TEXTURES_DIR = 'textures';
const THUMBNAIL_BASENAME = 'thumbnail';
const SEED_MARKER = '.seeded';

const CHANNEL_INDICES = [0, 1, 2, 3] as const;
type ChannelIndex = (typeof CHANNEL_INDICES)[number];

function isChannelIndex(value: number): value is ChannelIndex {
  return Number.isInteger(value) && value >= 0 && value <= 3;
}

export class ShaderStorage {
  private readonly dataDir: string;
  private readonly shadersDir: string;
  private readonly examplesDir: string;
  private readonly seed: boolean;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(options: StorageOptions = {}) {
    this.dataDir = path.resolve(options.dataDir ?? process.env['SHADER_DATA_DIR'] ?? 'data');
    this.shadersDir = path.join(this.dataDir, 'shaders');
    this.examplesDir = path.resolve(
      options.examplesDir ?? process.env['SHADER_EXAMPLES_DIR'] ?? 'examples',
    );
    this.seed = options.seed ?? process.env['SHADER_SEED'] !== '0';
  }

  private shaderDir(id: string): string {
    const validated = expect(validateId(id), `Invalid shader id "${id}"`);
    const dir = path.resolve(this.shadersDir, validated);
    const root = this.shadersDir + path.sep;
    if (!dir.startsWith(root)) {
      throw new StorageError('invalid', `Invalid shader id "${id}"`);
    }
    return dir;
  }

  private async withLock<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const current = previous.then(work, work);
    this.locks.set(
      id,
      current.catch(() => undefined),
    );
    try {
      return await current;
    } finally {
      if (this.locks.get(id) === current) this.locks.delete(id);
    }
  }

  private async writeFileAtomic(file: string, contents: string | Uint8Array): Promise<void> {
    const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      if (typeof contents === 'string') {
        await fs.writeFile(temp, contents, 'utf8');
      } else {
        await fs.writeFile(temp, contents);
      }
      await fs.rename(temp, file);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw new StorageError('io', `Failed to write ${path.basename(file)}`, [String(error)]);
    }
  }

  private texturesDir(dir: string): string {
    return path.join(dir, TEXTURES_DIR);
  }

  private textureFile(dir: string, channel: ChannelIndex, ext: string): string {
    return path.join(this.texturesDir(dir), `${channel}.${ext}`);
  }

  private thumbnailFile(dir: string, ext: string): string {
    return path.join(dir, `${THUMBNAIL_BASENAME}.${ext}`);
  }

  /**
   * Removes every `<basename>.*` in a directory. An image slot — a channel, or
   * the thumbnail — keeps its name and changes its extension when the format
   * changes, so replacing one means clearing whatever is there under any
   * extension, not just the one we are about to write.
   */
  private async removeSlotFiles(dir: string, basename: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    const prefix = `${basename}.`;
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => fs.rm(path.join(dir, entry), { force: true })),
    );
  }

  private removeTextureFile(dir: string, channel: ChannelIndex): Promise<void> {
    return this.removeSlotFiles(this.texturesDir(dir), String(channel));
  }

  private async copyTextures(
    fromDir: string,
    toDir: string,
    channels: TextureChannels,
  ): Promise<void> {
    await fs.mkdir(this.texturesDir(toDir), { recursive: true });
    await Promise.all(
      CHANNEL_INDICES.map(async (channel) => {
        const ext = channels[channel].ext;
        if (ext === null) return;
        try {
          await fs.copyFile(
            this.textureFile(fromDir, channel, ext),
            this.textureFile(toDir, channel, ext),
          );
        } catch (error) {
          console.warn(`[storage] failed to copy texture for channel ${channel}: ${String(error)}`);
        }
      }),
    );
  }

  private async readJson(file: string): Promise<unknown> {
    const raw = await fs.readFile(file, 'utf8');
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw new StorageError('io', `${path.basename(file)} is not valid JSON`, [String(error)]);
    }
  }

  private async exists(target: string): Promise<boolean> {
    try {
      await fs.access(target, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async init(): Promise<void> {
    await fs.mkdir(this.shadersDir, { recursive: true });
    await this.seedIfEmpty();
  }

  async listIds(): Promise<string[]> {
    let entries;
    try {
      entries = await fs.readdir(this.shadersDir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory() && validateId(entry.name).ok)
      .map((entry) => entry.name)
      .sort();
  }

  async list(): Promise<ShaderSummary[]> {
    const ids = await this.listIds();
    const records = await Promise.all(
      ids.map((id) =>
        this.read(id).catch((error: unknown) => {
          console.warn(`[storage] skipping shader "${id}": ${String(error)}`);
          return null;
        }),
      ),
    );

    return records
      .filter((record): record is ShaderRecord => record !== null)
      .map(toSummary)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async read(id: string): Promise<ShaderRecord> {
    const dir = this.shaderDir(id);

    let metaRaw: unknown;
    let fragment: string;
    let vertex: string;
    try {
      [metaRaw, fragment, vertex] = await Promise.all([
        this.readJson(path.join(dir, META_FILE)),
        fs.readFile(path.join(dir, FRAGMENT_FILE), 'utf8'),
        fs.readFile(path.join(dir, VERTEX_FILE), 'utf8'),
      ]);
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError('not_found', `Shader "${id}" was not found`);
    }

    const meta = this.parseMeta(id, metaRaw);
    const presets = await this.readPresets(dir, meta.controls);

    return { ...meta, fragment, vertex, presets };
  }

  private parseMeta(id: string, raw: unknown): ShaderMeta {
    const record = (raw ?? {}) as Record<string, unknown>;
    const name = expect(validateName(record['name'] ?? id), `Shader "${id}" has an invalid name`);
    const controls = expect(
      validateControls(record['controls'] ?? []),
      `Shader "${id}" has an invalid control schema`,
    );
    const description = expect(
      validateDescription(record['description']),
      `Shader "${id}" has an invalid description`,
    );

    const now = new Date().toISOString();
    return {
      id,
      name,
      description,
      ...(typeof record['author'] === 'string' ? { author: record['author'] } : {}),
      createdAt: typeof record['createdAt'] === 'string' ? record['createdAt'] : now,
      updatedAt: typeof record['updatedAt'] === 'string' ? record['updatedAt'] : now,
      controls,
      render: validateRender(record['render']),
      channels: validateChannels(record['channels']),
      thumbnail: validateThumbnailMeta(record['thumbnail']),
    };
  }

  private async readPresets(dir: string, controls: ShaderControl[]): Promise<Preset[]> {
    const file = path.join(dir, PRESETS_FILE);
    if (!(await this.exists(file))) return [];

    const raw = await this.readJson(file);
    const list = Array.isArray((raw as { presets?: unknown })?.presets)
      ? (raw as { presets: unknown[] }).presets
      : [];

    const presets: Preset[] = [];
    const used = new Set<string>();
    for (const [index, entry] of list.entries()) {
      const candidate = entry as Record<string, unknown> | null;
      const base =
        typeof candidate?.['id'] === 'string' && validateId(candidate['id']).ok
          ? (candidate['id'] as string)
          : slugify(
              typeof candidate?.['name'] === 'string' ? candidate['name'] : `preset-${index + 1}`,
            );
      const id = uniqueId(base, used);
      const result = validatePreset(entry, controls, id);
      if (result.ok) {
        used.add(id);
        presets.push(result.value);
      }
    }
    return presets;
  }

  private async writeMeta(dir: string, meta: ShaderMeta): Promise<void> {
    const persisted = {
      name: meta.name,
      description: meta.description,
      ...(meta.author ? { author: meta.author } : {}),
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      controls: meta.controls,
      render: meta.render,
      channels: meta.channels,
      thumbnail: meta.thumbnail,
    };

    await this.writeFileAtomic(
      path.join(dir, META_FILE),
      `${JSON.stringify(persisted, null, 2)}\n`,
    );
  }

  private async writePresets(dir: string, presets: Preset[]): Promise<void> {
    await this.writeFileAtomic(
      path.join(dir, PRESETS_FILE),
      `${JSON.stringify({ presets }, null, 2)}\n`,
    );
  }

  /**
   * Writes everything but the texture files for channels whose `data` is
   * `null` (metadata-only payload, e.g. a same-process duplicate) — those are
   * expected to be copied onto disk separately, by the caller.
   */
  private async writeAll(payload: ShaderPayload): Promise<ShaderRecord> {
    const dir = this.shaderDir(payload.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(this.texturesDir(dir), { recursive: true });

    const now = new Date().toISOString();
    const channels = payload.channels.map((channel) => ({
      ext: channel.ext,
      width: channel.width,
      height: channel.height,
      wrap: channel.wrap,
      filter: channel.filter,
      flipY: channel.flipY,
    })) as unknown as TextureChannels;

    const thumbnail: ThumbnailMeta | null = payload.thumbnail
      ? { ext: payload.thumbnail.ext, updatedAt: payload.thumbnail.updatedAt }
      : null;

    const meta: ShaderMeta = {
      id: payload.id,
      name: payload.name,
      description: payload.description,
      ...(payload.author ? { author: payload.author } : {}),
      createdAt: now,
      updatedAt: now,
      controls: payload.controls,
      render: payload.render,
      channels,
      thumbnail,
    };

    const textureWrites = CHANNEL_INDICES.map(async (channel) => {
      const entry = payload.channels[channel];
      if (entry.ext === null || entry.data === null) return;
      await this.writeFileAtomic(
        this.textureFile(dir, channel, entry.ext),
        Buffer.from(entry.data, 'base64'),
      );
    });

    await Promise.all([
      this.writeMeta(dir, meta),
      this.writeFileAtomic(path.join(dir, FRAGMENT_FILE), payload.fragment),
      this.writeFileAtomic(path.join(dir, VERTEX_FILE), payload.vertex),
      this.writePresets(dir, payload.presets),
      ...textureWrites,
      payload.thumbnail
        ? this.writeFileAtomic(
            this.thumbnailFile(dir, payload.thumbnail.ext),
            Buffer.from(payload.thumbnail.data, 'base64'),
          )
        : Promise.resolve(),
    ]);

    return {
      ...meta,
      fragment: payload.fragment,
      vertex: payload.vertex,
      presets: payload.presets,
    };
  }

  async create(input: {
    name: unknown;
    description?: unknown;
    controls?: unknown;
    render?: unknown;
    fragment?: unknown;
    vertex?: unknown;
  }): Promise<ShaderRecord> {
    const name = expect(validateName(input.name), 'Invalid shader name');
    const description = expect(validateDescription(input.description), 'Invalid description');

    const fragment = expect(
      validateSource(input.fragment ?? TEMPLATE_FRAGMENT, 'fragment'),
      'Invalid fragment shader',
    );
    const vertex = expect(
      validateSource(input.vertex ?? DEFAULT_VERTEX, 'vertex'),
      'Invalid vertex shader',
    );
    const controls = expect(
      validateControls(input.controls ?? TEMPLATE_CONTROLS),
      'Invalid control schema',
    );

    const id = uniqueId(slugify(name), await this.listIds());

    return this.withLock(id, () =>
      this.writeAll({
        id,
        name,
        description,
        controls,
        render: input.render === undefined ? { ...DEFAULT_RENDER } : validateRender(input.render),
        fragment,
        vertex,
        presets: [],
        channels: DEFAULT_CHANNELS.map((channel) => ({
          ...channel,
          data: null,
        })) as unknown as TextureChannelPayloads,
        // A brand-new shader has never been rendered, so there is nothing to
        // preview yet. Its first save captures one.
        thumbnail: null,
      }),
    );
  }

  async update(
    id: string,
    patch: {
      name?: unknown;
      description?: unknown;
      controls?: unknown;
      render?: unknown;
      fragment?: unknown;
      vertex?: unknown;
      /** Settings only (wrap/filter/flipY) — never carries image bytes. */
      channels?: unknown;
    },
  ): Promise<ShaderRecord> {
    return this.withLock(id, async () => {
      const current = await this.read(id);
      const dir = this.shaderDir(id);

      const name =
        patch.name === undefined
          ? current.name
          : expect(validateName(patch.name), 'Invalid shader name');
      const description =
        patch.description === undefined
          ? current.description
          : expect(validateDescription(patch.description), 'Invalid description');
      const controls =
        patch.controls === undefined
          ? current.controls
          : expect(validateControls(patch.controls), 'Invalid control schema');
      const fragment =
        patch.fragment === undefined
          ? current.fragment
          : expect(validateSource(patch.fragment, 'fragment'), 'Invalid fragment shader');
      const vertex =
        patch.vertex === undefined
          ? current.vertex
          : expect(validateSource(patch.vertex, 'vertex'), 'Invalid vertex shader');
      const render: RenderSettings =
        patch.render === undefined ? current.render : validateRender(patch.render);
      const channels: TextureChannels =
        patch.channels === undefined
          ? current.channels
          : this.mergeChannelSettings(
              current.channels,
              validateChannelSettingsPatch(patch.channels),
            );

      const presets =
        patch.controls === undefined
          ? current.presets
          : current.presets.map((preset) => ({
              ...preset,
              values: sanitizeParams(controls, preset.values),
            }));

      const meta: ShaderMeta = {
        ...current,
        name,
        description,
        controls,
        render,
        channels,
        updatedAt: new Date().toISOString(),
      };

      await Promise.all([
        this.writeMeta(dir, meta),
        fragment === current.fragment
          ? Promise.resolve()
          : this.writeFileAtomic(path.join(dir, FRAGMENT_FILE), fragment),
        vertex === current.vertex
          ? Promise.resolve()
          : this.writeFileAtomic(path.join(dir, VERTEX_FILE), vertex),
        patch.controls === undefined ? Promise.resolve() : this.writePresets(dir, presets),
      ]);

      return { ...meta, fragment, vertex, presets };
    });
  }

  private mergeChannelSettings(
    current: TextureChannels,
    patch: TextureChannelSettingsPatch[],
  ): TextureChannels {
    return CHANNEL_INDICES.map((channel) => ({
      ...current[channel],
      ...patch[channel],
    })) as unknown as TextureChannels;
  }

  async remove(id: string): Promise<void> {
    const dir = this.shaderDir(id);
    return this.withLock(id, async () => {
      if (!(await this.exists(dir))) {
        throw new StorageError('not_found', `Shader "${id}" was not found`);
      }
      await fs.rm(dir, { recursive: true, force: true });
    });
  }

  async duplicate(id: string, name?: unknown): Promise<ShaderRecord> {
    const source = await this.read(id);
    const copyName = expect(
      validateName(name ?? `${source.name} copy`.slice(0, LIMITS.nameLength)),
      'Invalid shader name',
    );
    const copyId = uniqueId(slugify(copyName), await this.listIds());

    const thumbnail = await this.readThumbnailPayload(source);

    return this.withLock(copyId, async () => {
      const record = await this.writeAll({
        ...toPayload(source),
        id: copyId,
        name: copyName,
        presets: source.presets.map((preset) => ({ ...preset })),
        // The copy is pixel-for-pixel the same shader, so it inherits the
        // original's preview rather than looking blank until its first save.
        thumbnail,
      });
      // `toPayload` never touches disk, so its channels carry no image bytes
      // (`data` is always `null`) — copy the actual files across ourselves.
      await this.copyTextures(this.shaderDir(id), this.shaderDir(copyId), source.channels);
      return record;
    });
  }

  // --- Texture channels ----------------------------------------------------

  async setTexture(
    id: string,
    channel: number,
    input: { ext: string; bytes: Buffer; width: number; height: number },
  ): Promise<ShaderRecord> {
    if (!isChannelIndex(channel)) {
      throw new StorageError('invalid', `Invalid channel index "${channel}"`);
    }
    const ext = input.ext.toLowerCase();
    if (!TEXTURE_EXTENSIONS.has(ext)) {
      throw new StorageError('invalid', `Unsupported image type ".${input.ext}"`);
    }
    if (!Buffer.isBuffer(input.bytes) || input.bytes.byteLength === 0) {
      throw new StorageError('invalid', 'Texture data is empty');
    }
    if (input.bytes.byteLength > LIMITS.textureBytes) {
      throw new StorageError(
        'invalid',
        `Texture must be at most ${Math.round(LIMITS.textureBytes / (1024 * 1024))} MB`,
      );
    }
    const width = Math.round(input.width);
    const height = Math.round(input.height);
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0 ||
      width > LIMITS.textureDimension ||
      height > LIMITS.textureDimension
    ) {
      throw new StorageError('invalid', 'Invalid texture dimensions');
    }

    return this.withLock(id, async () => {
      const current = await this.read(id);
      const dir = this.shaderDir(id);

      await fs.mkdir(this.texturesDir(dir), { recursive: true });
      // The previous file for this channel may have had a different extension.
      await this.removeTextureFile(dir, channel);
      await this.writeFileAtomic(this.textureFile(dir, channel, ext), input.bytes);

      const channels = CHANNEL_INDICES.map((index) =>
        index === channel
          ? { ...current.channels[index], ext, width, height }
          : current.channels[index],
      ) as unknown as TextureChannels;

      const meta: ShaderMeta = { ...current, channels, updatedAt: new Date().toISOString() };
      await this.writeMeta(dir, meta);
      return {
        ...meta,
        fragment: current.fragment,
        vertex: current.vertex,
        presets: current.presets,
      };
    });
  }

  async clearTexture(id: string, channel: number): Promise<ShaderRecord> {
    if (!isChannelIndex(channel)) {
      throw new StorageError('invalid', `Invalid channel index "${channel}"`);
    }

    return this.withLock(id, async () => {
      const current = await this.read(id);
      const dir = this.shaderDir(id);

      await this.removeTextureFile(dir, channel);

      const channels = CHANNEL_INDICES.map((index) =>
        index === channel ? { ...DEFAULT_TEXTURE_CHANNEL } : current.channels[index],
      ) as unknown as TextureChannels;

      const meta: ShaderMeta = { ...current, channels, updatedAt: new Date().toISOString() };
      await this.writeMeta(dir, meta);
      return {
        ...meta,
        fragment: current.fragment,
        vertex: current.vertex,
        presets: current.presets,
      };
    });
  }

  /** Reads a channel's raw image bytes back, for serving to the client. */
  async readTexture(id: string, channel: number): Promise<{ bytes: Buffer; ext: string } | null> {
    if (!isChannelIndex(channel)) return null;

    const record = await this.read(id);
    const ext = record.channels[channel].ext;
    if (ext === null) return null;

    try {
      const bytes = await fs.readFile(this.textureFile(this.shaderDir(id), channel, ext));
      return { bytes, ext };
    } catch {
      return null;
    }
  }

  // --- Thumbnail -----------------------------------------------------------

  /**
   * Stores the preview the client captured from the renderer.
   *
   * This deliberately leaves `updatedAt` alone: a thumbnail is a picture *of*
   * the document, not a change *to* it, and bumping it would reorder a
   * "recently modified" listing every time a preview was refreshed.
   */
  async setThumbnail(id: string, input: { ext: string; bytes: Buffer }): Promise<ShaderRecord> {
    const ext = input.ext.toLowerCase();
    if (!TEXTURE_EXTENSIONS.has(ext)) {
      throw new StorageError('invalid', `Unsupported image type ".${input.ext}"`);
    }
    if (!Buffer.isBuffer(input.bytes) || input.bytes.byteLength === 0) {
      throw new StorageError('invalid', 'Thumbnail data is empty');
    }
    if (input.bytes.byteLength > LIMITS.thumbnailBytes) {
      throw new StorageError(
        'invalid',
        `Thumbnail must be at most ${Math.round(LIMITS.thumbnailBytes / 1024)} KB`,
      );
    }

    return this.withLock(id, async () => {
      const current = await this.read(id);
      const dir = this.shaderDir(id);

      await this.removeSlotFiles(dir, THUMBNAIL_BASENAME);
      await this.writeFileAtomic(this.thumbnailFile(dir, ext), input.bytes);

      const meta: ShaderMeta = {
        ...current,
        thumbnail: { ext, updatedAt: new Date().toISOString() },
      };
      await this.writeMeta(dir, meta);
      return {
        ...meta,
        fragment: current.fragment,
        vertex: current.vertex,
        presets: current.presets,
      };
    });
  }

  /** Reads the preview's raw image bytes back, for serving to the client. */
  async readThumbnail(id: string): Promise<{ bytes: Buffer; ext: string } | null> {
    const record = await this.read(id);
    if (!record.thumbnail) return null;

    const { ext } = record.thumbnail;
    try {
      const bytes = await fs.readFile(this.thumbnailFile(this.shaderDir(id), ext));
      return { bytes, ext };
    } catch {
      return null;
    }
  }

  /** The preview as a bundle carries it. `null` when the shader has none, or its file is gone. */
  private async readThumbnailPayload(record: ShaderRecord): Promise<ThumbnailPayload | null> {
    if (!record.thumbnail) return null;

    const thumbnail = await this.readThumbnail(record.id);
    if (!thumbnail) {
      console.warn(`[storage] thumbnail of "${record.id}" is missing on disk`);
      return null;
    }
    return { ...record.thumbnail, data: thumbnail.bytes.toString('base64') };
  }

  async savePreset(
    id: string,
    input: { name: unknown; values: unknown; render?: unknown },
  ): Promise<Preset> {
    return this.withLock(id, async () => {
      const shader = await this.read(id);
      const dir = this.shaderDir(id);

      const name = expect(validateName(input.name, 'preset.name'), 'Invalid preset name');
      if (shader.presets.length >= LIMITS.presetCount) {
        throw new StorageError(
          'conflict',
          `Shader "${id}" already has the maximum number of presets`,
        );
      }

      const existing = shader.presets.find((preset) => preset.name === name);
      const presetId =
        existing?.id ??
        uniqueId(
          slugify(name),
          shader.presets.map((preset) => preset.id),
        );

      const preset: Preset = {
        id: presetId,
        name,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        values: sanitizeParams(shader.controls, input.values as ShaderParams),
        // A caller that sends no render settings is saying "values only", not
        // "the defaults" — so the field stays off the preset entirely.
        ...(input.render === undefined || input.render === null
          ? {}
          : { render: validateRender(input.render) }),
      };

      const presets = existing
        ? shader.presets.map((entry) => (entry.id === presetId ? preset : entry))
        : [...shader.presets, preset];

      await this.writePresets(dir, presets);
      await this.touch(dir, shader);
      return preset;
    });
  }

  async deletePreset(id: string, presetId: string): Promise<void> {
    expect(validateId(presetId), `Invalid preset id "${presetId}"`);

    return this.withLock(id, async () => {
      const shader = await this.read(id);
      const dir = this.shaderDir(id);

      const presets = shader.presets.filter((preset) => preset.id !== presetId);
      if (presets.length === shader.presets.length) {
        throw new StorageError('not_found', `Preset "${presetId}" was not found on shader "${id}"`);
      }

      await this.writePresets(dir, presets);
      await this.touch(dir, shader);
    });
  }

  private async touch(dir: string, meta: ShaderMeta): Promise<void> {
    await this.writeMeta(dir, { ...meta, updatedAt: new Date().toISOString() });
  }

  /** Embeds each assigned channel's image as base64 — this is what makes the bundle portable. */
  async exportOne(id: string): Promise<ShaderPayload> {
    const record = await this.read(id);
    const payload = toPayload(record);
    const dir = this.shaderDir(id);

    const channels = await Promise.all(
      CHANNEL_INDICES.map(async (channel) => {
        const entry = payload.channels[channel];
        if (entry.ext === null) return entry;
        try {
          const bytes = await fs.readFile(this.textureFile(dir, channel, entry.ext));
          return { ...entry, data: bytes.toString('base64') };
        } catch (error) {
          console.warn(`[storage] failed to read texture ${channel} of "${id}": ${String(error)}`);
          return { ...DEFAULT_TEXTURE_CHANNEL, data: null };
        }
      }),
    );

    return {
      ...payload,
      channels: channels as unknown as TextureChannelPayloads,
      thumbnail: await this.readThumbnailPayload(record),
    };
  }

  async exportAll(): Promise<ShaderPayload[]> {
    const ids = await this.listIds();
    const payloads: ShaderPayload[] = [];
    for (const id of ids) {
      try {
        payloads.push(await this.exportOne(id));
      } catch (error) {
        console.warn(`[storage] excluding shader "${id}" from export: ${String(error)}`);
      }
    }
    return payloads;
  }

  async importPayloads(payloads: ShaderPayload[], mode: ImportMode): Promise<ImportResult> {
    const imported: ImportResult['imported'] = [];
    const taken = new Set(await this.listIds());

    for (const payload of payloads) {
      const collides = taken.has(payload.id);
      const replaced = collides && mode === 'overwrite';
      const id = replaced || !collides ? payload.id : uniqueId(payload.id, taken);

      await this.withLock(id, async () => {
        if (replaced) {
          await fs.rm(this.shaderDir(id), { recursive: true, force: true });
        }
        await this.writeAll({ ...payload, id });
      });

      taken.add(id);
      imported.push({ id, name: payload.name, replaced });
    }

    return { imported };
  }

  private async seedIfEmpty(): Promise<void> {
    if (!this.seed) return;
    if (await this.exists(path.join(this.dataDir, SEED_MARKER))) return;
    if ((await this.listIds()).length > 0) {
      await this.writeFileAtomic(path.join(this.dataDir, SEED_MARKER), new Date().toISOString());
      return;
    }

    let examples: string[];
    try {
      const entries = await fs.readdir(path.join(this.examplesDir, 'shaders'), {
        withFileTypes: true,
      });
      examples = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      console.warn(`[storage] no examples found at ${this.examplesDir}; starting empty`);
      return;
    }

    for (const id of examples) {
      try {
        await fs.cp(path.join(this.examplesDir, 'shaders', id), path.join(this.shadersDir, id), {
          recursive: true,
        });
      } catch (error) {
        console.warn(`[storage] failed to seed example "${id}": ${String(error)}`);
      }
    }

    await this.writeFileAtomic(path.join(this.dataDir, SEED_MARKER), new Date().toISOString());
    console.log(`[storage] seeded ${examples.length} example shader(s) into ${this.shadersDir}`);
  }
}
