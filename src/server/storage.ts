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
} from '../shared/model';
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
  type Result,
} from '../shared/validate';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Everything the routes need in order to answer with a useful status code. */
export class StorageError extends Error {
  constructor(
    readonly code: 'not_found' | 'conflict' | 'invalid' | 'io',
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'StorageError';
  }

  get status(): number {
    switch (this.code) {
      case 'not_found':
        return 404;
      case 'conflict':
        return 409;
      case 'invalid':
        return 400;
      case 'io':
        return 500;
      default:
        return 500;
    }
  }
}

function invalid(result: { errors: string[] }, message: string): never {
  throw new StorageError('invalid', message, result.errors);
}

/** Unwrap a validation Result or turn it into a 400. */
function expect<T>(result: Result<T>, message: string): T {
  if (!result.ok) invalid(result, message);
  return result.value;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export interface StorageOptions {
  /** Where shaders live. Defaults to `<cwd>/data`. */
  dataDir?: string;
  /** Seeded into an empty store on first run. Defaults to `<cwd>/examples`. */
  examplesDir?: string;
}

const META_FILE = 'meta.json';
const FRAGMENT_FILE = 'fragment.glsl';
const VERTEX_FILE = 'vertex.glsl';
const PRESETS_FILE = 'presets.json';
const SEED_MARKER = '.seeded';

export class ShaderStorage {
  private readonly dataDir: string;
  private readonly shadersDir: string;
  private readonly examplesDir: string;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(options: StorageOptions = {}) {
    this.dataDir = path.resolve(options.dataDir ?? process.env['SHADER_DATA_DIR'] ?? 'data');
    this.shadersDir = path.join(this.dataDir, 'shaders');
    this.examplesDir = path.resolve(
      options.examplesDir ?? process.env['SHADER_EXAMPLES_DIR'] ?? 'examples',
    );
  }

  /**
   * Resolve a shader directory. The id is validated first, then the resolved
   * path is checked to still sit under the shaders root — belt and braces
   * against a traversal slipping through a future change to the pattern.
   */
  private shaderDir(id: string): string {
    const validated = expect(validateId(id), `Invalid shader id "${id}"`);
    const dir = path.resolve(this.shadersDir, validated);
    const root = this.shadersDir + path.sep;
    if (!dir.startsWith(root)) {
      throw new StorageError('invalid', `Invalid shader id "${id}"`);
    }
    return dir;
  }

  /**
   * Serialize mutations per shader id. Reads are not locked: the worst a reader
   * can see is the previous complete version, because writes are atomic.
   */
  private async withLock<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const current = previous.then(work, work);
    // Keep the chain alive on failure, but do not leave an unhandled rejection.
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

  // -------------------------------------------------------------------------
  // Low-level IO
  // -------------------------------------------------------------------------

  /**
   * Write via a temp file in the same directory, then rename. Rename is atomic
   * within a filesystem, so a reader sees either the old file or the new one —
   * never a truncated one — even if the process dies mid-write.
   */
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

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

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

  /**
   * A directory whose meta.json is unreadable is skipped rather than fatal:
   * one corrupt shader must not take the whole browser down with it.
   */
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

  /** Files on disk are still untrusted input — they may have been hand-edited. */
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

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * The id is not written into meta.json: the directory name already *is* the
   * id, and storing it twice invites the two to disagree after a manual copy.
   */
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

  /**
   * Partial update. Only the fields present in `patch` are touched; the rest of
   * the shader is read back and rewritten unchanged.
   *
   * Editing `controls` re-projects every preset onto the new schema, so a
   * preset never carries a value for a control that no longer exists.
   */
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
        // Presets come along, but get ids of their own scoped to the copy.
        presets: source.presets.map((preset) => ({ ...preset })),
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Presets
  // -------------------------------------------------------------------------

  async savePreset(id: string, input: { name: unknown; values: unknown }): Promise<Preset> {
    return this.withLock(id, async () => {
      const shader = await this.read(id);
      const dir = this.shaderDir(id);

      const name = expect(validateName(input.name, 'preset.name'), 'Invalid preset name');
      if (shader.presets.length >= LIMITS.presetCount) {
        throw new StorageError('conflict', `Shader "${id}" already has the maximum number of presets`);
      }

      // Saving over a preset of the same name replaces it: re-saving from the
      // GUI is the common case, and it should not pile up duplicates.
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

  // -------------------------------------------------------------------------
  // Import / export
  // -------------------------------------------------------------------------

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

  /**
   * Import validated payloads.
   *
   * `rename` (the default) never destroys anything: a colliding id is given a
   * fresh suffixed one. `overwrite` replaces the shader that already holds the
   * id, which is what makes an export/import round trip idempotent.
   */
  async importPayloads(payloads: ShaderPayload[], mode: ImportMode): Promise<ImportResult> {
    const imported: ImportResult['imported'] = [];
    // Accumulates across the loop so two shaders in one bundle cannot both
    // claim the same freshly-generated id.
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

  // -------------------------------------------------------------------------
  // Seeding
  // -------------------------------------------------------------------------

  /**
   * Copy the bundled examples into an empty store. The `.seeded` marker means a
   * user who deletes every example does not find them back after a restart.
   */
  private async seedIfEmpty(): Promise<void> {
    if (process.env['SHADER_SEED'] === '0') return;
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

// ---------------------------------------------------------------------------
// The starting point for a brand new shader
// ---------------------------------------------------------------------------

export const DEFAULT_VERTEX = `varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const TEMPLATE_CONTROLS: ShaderControl[] = [
  { key: 'timeScale', type: 'number', label: 'Time Scale', folder: 'Motion', default: 0.4, min: 0, max: 2 },
  { key: 'scale', type: 'number', label: 'Scale', folder: 'Structure', default: 3, min: 0.5, max: 12 },
  { key: 'colorA', type: 'color', label: 'Color A', folder: 'Palette', default: '#1b2a4a' },
  { key: 'colorB', type: 'color', label: 'Color B', folder: 'Palette', default: '#5ad1c8' },
];

export const TEMPLATE_FRAGMENT = `precision highp float;

// Built-in uniforms, always provided by the engine.
uniform vec2 iResolution;
uniform float iTime;

// One uniform per control in the schema, named u_<key>.
uniform float u_timeScale;
uniform float u_scale;
uniform vec3 u_colorA;
uniform vec3 u_colorB;

varying vec2 vUv;

void main() {
  vec2 uv = vUv;
  uv.x *= iResolution.x / iResolution.y;

  float t = iTime * u_timeScale;
  float wave = sin(uv.x * u_scale + t) * 0.5 + 0.5;
  wave *= sin(uv.y * u_scale - t * 0.7) * 0.5 + 0.5;

  vec3 color = mix(u_colorA, u_colorB, wave);
  gl_FragColor = vec4(color, 1.0);
}
`;
