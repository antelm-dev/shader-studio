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
  DEFAULT_RENDER,
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
} from '../../shared/model';
import {
  LIMITS,
  sanitizeParams,
  slugify,
  uniqueId,
  validateControls,
  validateDescription,
  validateId,
  validateName,
  validatePreset,
  validateRender,
  validateSource,
} from '../../shared/validate';
import { expect, StorageError } from './storage-error';
import { DEFAULT_VERTEX, TEMPLATE_CONTROLS, TEMPLATE_FRAGMENT } from './templates';
import type { StorageOptions } from './types';

const META_FILE = 'meta.json';
const FRAGMENT_FILE = 'fragment.glsl';
const VERTEX_FILE = 'vertex.glsl';
const PRESETS_FILE = 'presets.json';
const SEED_MARKER = '.seeded';

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

  private async writeFileAtomic(file: string, contents: string): Promise<void> {
    const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temp, contents, 'utf8');
      await fs.rename(temp, file);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw new StorageError('io', `Failed to write ${path.basename(file)}`, [String(error)]);
    }
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
    };
  }

  private async readPresets(dir: string, controls: ShaderControl[]): Promise<Preset[]> {
    const file = path.join(dir, PRESETS_FILE);
    if (!(await this.exists(file))) return [];

    const raw = await this.readJson(file);
    const list = Array.isArray((raw as { presets?: unknown })?.presets)
      ? ((raw as { presets: unknown[] }).presets)
      : [];

    const presets: Preset[] = [];
    const used = new Set<string>();
    for (const [index, entry] of list.entries()) {
      const candidate = entry as Record<string, unknown> | null;
      const base =
        typeof candidate?.['id'] === 'string' && validateId(candidate['id']).ok
          ? (candidate['id'] as string)
          : slugify(typeof candidate?.['name'] === 'string' ? candidate['name'] : `preset-${index + 1}`);
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

  private async writeAll(payload: ShaderPayload): Promise<ShaderRecord> {
    const dir = this.shaderDir(payload.id);
    await fs.mkdir(dir, { recursive: true });

    const now = new Date().toISOString();
    const meta: ShaderMeta = {
      id: payload.id,
      name: payload.name,
      description: payload.description,
      ...(payload.author ? { author: payload.author } : {}),
      createdAt: now,
      updatedAt: now,
      controls: payload.controls,
      render: payload.render,
    };

    await Promise.all([
      this.writeMeta(dir, meta),
      this.writeFileAtomic(path.join(dir, FRAGMENT_FILE), payload.fragment),
      this.writeFileAtomic(path.join(dir, VERTEX_FILE), payload.vertex),
      this.writePresets(dir, payload.presets),
    ]);

    return { ...meta, fragment: payload.fragment, vertex: payload.vertex, presets: payload.presets };
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
    },
  ): Promise<ShaderRecord> {
    return this.withLock(id, async () => {
      const current = await this.read(id);
      const dir = this.shaderDir(id);

      const name = patch.name === undefined ? current.name : expect(validateName(patch.name), 'Invalid shader name');
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

    return this.withLock(copyId, () =>
      this.writeAll({
        ...toPayload(source),
        id: copyId,
        name: copyName,
        presets: source.presets.map((preset) => ({ ...preset })),
      }),
    );
  }

  async savePreset(id: string, input: { name: unknown; values: unknown }): Promise<Preset> {
    return this.withLock(id, async () => {
      const shader = await this.read(id);
      const dir = this.shaderDir(id);

      const name = expect(validateName(input.name, 'preset.name'), 'Invalid preset name');
      if (shader.presets.length >= LIMITS.presetCount) {
        throw new StorageError('conflict', `Shader "${id}" already has the maximum number of presets`);
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

  async exportOne(id: string): Promise<ShaderPayload> {
    return toPayload(await this.read(id));
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
