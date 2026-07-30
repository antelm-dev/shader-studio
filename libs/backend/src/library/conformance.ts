/**
 * A single behavioural suite every storage engine must pass. Both the SQLite and
 * the Postgres spec import `runShaderLibraryConformance` and hand it a harness
 * that provisions an empty store of their kind; the assertions below then run
 * against a real `ShaderLibrary` on top of it. This is where the guarantee that
 * "the logic is not duplicated between engines" is actually enforced — one suite,
 * two backends.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_CHANNELS,
  DEFAULT_RENDER,
  LEGACY_BUNDLE_FORMAT,
  getBloomEffect,
  type ShaderPayload,
  type TextureChannelPayloads,
} from '@shader-studio/shared/model';
import {
  addBuffer,
  addFile,
  bufferPasses,
  imagePass,
  migrateLegacyProject,
  setChannelBinding,
} from '@shader-studio/shared/project';
import { buildCollectionBundle, parseBundle } from '@shader-studio/shared/validate';
import { DEFAULT_VERTEX, TEMPLATE_FRAGMENT } from '@shader-studio/shared/templates';

import { ShaderLibrary, type PayloadSource } from './shader-library';
import { StorageError } from './storage-error';
import type { AssetKey, ShaderRepository } from '../persistence/shader-repository';

export interface ConformanceHarness {
  /** A repository over this harness's (empty) store. Calling again re-opens the same store. */
  makeRepository(): ShaderRepository;
  /** Drops the store and releases resources. */
  cleanup(): Promise<void>;
  /** Overwrites a shader's `project_json` with invalid JSON, for corruption tests. */
  corruptProjectJson(id: string): Promise<void>;
  /** Deletes an asset row directly, leaving `channels_json` pointing at bytes that are gone. */
  removeAssetRow(id: string, key: AssetKey): Promise<void>;
}

const PNG = Buffer.from('a fake png image').toString('base64');
const WEBP = Buffer.from('a fake webp preview').toString('base64');
const FRAGMENT = 'void main() { gl_FragColor = vec4(1.0); }';

function payloadOf(id: string, name: string, extra: Partial<ShaderPayload> = {}): ShaderPayload {
  return {
    id,
    name,
    description: '',
    controls: [],
    render: { ...DEFAULT_RENDER },
    fragment: TEMPLATE_FRAGMENT,
    vertex: DEFAULT_VERTEX,
    presets: [],
    channels: DEFAULT_CHANNELS.map((channel) => ({
      ...channel,
      data: null,
    })) as unknown as TextureChannelPayloads,
    thumbnail: null,
    project: migrateLegacyProject(TEMPLATE_FRAGMENT, DEFAULT_VERTEX),
    ...extra,
  };
}

function withTexture(payload: ShaderPayload, channel: number, data = PNG): ShaderPayload {
  const channels = payload.channels.map((entry, index) =>
    index === channel ? { ...entry, ext: 'png', width: 2, height: 2, data } : entry,
  ) as unknown as TextureChannelPayloads;
  return { ...payload, channels };
}

export function runShaderLibraryConformance(
  engine: string,
  newHarness: () => ConformanceHarness,
): void {
  describe(`ShaderLibrary conformance (${engine})`, () => {
    let harness: ConformanceHarness;
    let lib: ShaderLibrary;

    beforeEach(async () => {
      harness = newHarness();
      lib = new ShaderLibrary(harness.makeRepository());
      await lib.init();
    });

    afterEach(async () => {
      await lib.close().catch(() => undefined);
      await harness.cleanup();
    });

    // 1 — initialisation & migrations
    it('starts empty and re-initialises idempotently', async () => {
      expect(await lib.list()).toEqual([]);
      await lib.init();
      expect(await lib.list()).toEqual([]);
    });

    // 2 — create
    it('creates a shader from the template', async () => {
      const shader = await lib.create({ name: 'Hex Pulse' });
      expect(shader.id).toBe('hex-pulse');
      expect(shader.revision).toBe(1);
      expect(shader.fragment).toBe(TEMPLATE_FRAGMENT);
      expect(shader.vertex).toBe(DEFAULT_VERTEX);
    });

    it('suffixes an id that is already taken', async () => {
      await lib.create({ name: 'Waves' });
      const second = await lib.create({ name: 'Waves' });
      expect(second.id).toBe('waves-2');
    });

    it('rejects an empty name and an invalid control schema', async () => {
      await expect(lib.create({ name: '  ' })).rejects.toMatchObject({ code: 'invalid' });
      await expect(
        lib.create({ name: 'Bad', controls: [{ key: 'x', type: 'color', default: 'red' }] }),
      ).rejects.toMatchObject({ code: 'invalid' });
      expect(await lib.list()).toEqual([]);
    });

    // 3 — read
    it('404s on a missing shader and rejects a traversing id', async () => {
      await expect(lib.read('nope')).rejects.toMatchObject({ code: 'not_found' });
      for (const id of ['..', '../etc', 'a/b', 'a\\b', '%2e%2e']) {
        await expect(lib.read(id)).rejects.toMatchObject({ code: 'invalid' });
      }
    });

    // 4 — sorted list
    it('lists summaries sorted by name', async () => {
      await lib.create({ name: 'Banana' });
      await lib.create({ name: 'Apple' });
      await lib.create({ name: 'Cherry' });
      expect((await lib.list()).map((entry) => entry.name)).toEqual(['Apple', 'Banana', 'Cherry']);
    });

    // 5 — cascade delete (a successful delete of a shader that has presets + assets proves the FK cascade)
    it('deletes a shader together with its presets and assets', async () => {
      const { id } = await lib.create({ name: 'Doomed' });
      await lib.savePreset(id, { name: 'P', values: {} });
      await lib.setTexture(id, 0, { ext: 'png', bytes: Buffer.from('x'), width: 1, height: 1 });
      await lib.setThumbnail(id, { ext: 'png', bytes: Buffer.from('y') });

      await lib.remove(id);
      expect(await lib.list()).toEqual([]);
      await expect(lib.read(id)).rejects.toMatchObject({ code: 'not_found' });
      await expect(lib.remove(id)).rejects.toMatchObject({ code: 'not_found' });
    });

    // 6 — update
    it('updates only the given fields and bumps the revision', async () => {
      const created = await lib.create({ name: 'Demo' });
      const updated = await lib.update(created.id, { fragment: FRAGMENT });
      expect(updated.fragment).toBe(FRAGMENT);
      expect(updated.name).toBe('Demo');
      expect(updated.vertex).toBe(created.vertex);
      expect(updated.revision).toBe(created.revision + 1);
    });

    it('renames without changing the id and re-projects presets on a schema change', async () => {
      const created = await lib.create({
        name: 'Demo',
        controls: [
          { key: 'speed', type: 'number', default: 1, min: 0, max: 2 },
          { key: 'gone', type: 'number', default: 5, min: 0, max: 10 },
        ],
      });
      await lib.savePreset(created.id, { name: 'Fast', values: { speed: 2, gone: 9 } });
      const updated = await lib.update(created.id, {
        name: 'Renamed',
        controls: [{ key: 'speed', type: 'number', default: 0.5, min: 0, max: 1 }],
      });
      expect(updated.id).toBe(created.id);
      expect(updated.name).toBe('Renamed');
      expect(updated.presets[0].values).toEqual({ speed: 1 });
    });

    it('rejects an invalid patch without changing what is stored', async () => {
      const { id } = await lib.create({ name: 'Demo' });
      const before = await lib.read(id);
      await expect(lib.update(id, { fragment: '' })).rejects.toMatchObject({ code: 'invalid' });
      expect((await lib.read(id)).fragment).toBe(before.fragment);
    });

    // 7 — duplicate
    it('duplicates a shader with its schema, presets, project and assets', async () => {
      const created = await lib.create({ name: 'Original' });
      // Add structure first (project is the source of truth), then reconcile the
      // fragment onto it — a fragment-only patch keeps the buffers and files.
      await lib.update(created.id, { project: addFile(addBuffer(created.project), 'lib.glsl') });
      await lib.update(created.id, { fragment: FRAGMENT });
      await lib.savePreset(created.id, { name: 'Warm', values: {} });
      await lib.setTexture(created.id, 1, {
        ext: 'png',
        bytes: Buffer.from('tex'),
        width: 2,
        height: 2,
      });
      await lib.setThumbnail(created.id, { ext: 'webp', bytes: Buffer.from('thumb') });

      const copy = await lib.duplicate(created.id, 'Copy');
      expect(copy.id).toBe('copy');
      expect(copy.fragment).toBe(FRAGMENT);
      expect(copy.presets.map((preset) => preset.name)).toEqual(['Warm']);
      expect(bufferPasses(copy.project)).toHaveLength(1);
      expect(copy.project.files.map((file) => file.name)).toEqual(['lib.glsl']);
      expect((await lib.readTexture(copy.id, 1))?.bytes).toEqual(
        new Uint8Array(Buffer.from('tex')),
      );
      expect(copy.thumbnail?.ext).toBe('webp');
      expect((await lib.read(created.id)).name).toBe('Original');
    });

    it('defaults the copy name to "<name> copy"', async () => {
      const { id } = await lib.create({ name: 'Original' });
      expect((await lib.duplicate(id)).name).toBe('Original copy');
    });

    // 8 — presets
    it('sanitises, overwrites by name, and deletes presets', async () => {
      const created = await lib.create({
        name: 'Demo',
        controls: [{ key: 'speed', type: 'number', default: 1, min: 0, max: 2 }],
      });
      const id = created.id;
      const wild = await lib.savePreset(id, { name: 'Wild', values: { speed: 999, bogus: 'x' } });
      expect(wild.values).toEqual({ speed: 2 });

      const first = await lib.savePreset(id, { name: 'Look', values: {} });
      const second = await lib.savePreset(id, { name: 'Look', values: {} });
      expect(second.id).toBe(first.id);
      expect((await lib.read(id)).presets).toHaveLength(2);

      await lib.deletePreset(id, first.id);
      expect((await lib.read(id)).presets.map((preset) => preset.name)).toEqual(['Wild']);
      await expect(lib.deletePreset(id, 'ghost')).rejects.toMatchObject({ code: 'not_found' });
    });

    it('keeps render off a values-only preset and clamps a supplied one', async () => {
      const { id } = await lib.create({ name: 'Demo' });
      await lib.savePreset(id, { name: 'Values', values: {} });
      expect((await lib.read(id)).presets[0].render).toBeUndefined();

      const glow = await lib.savePreset(id, {
        name: 'Glow',
        values: {},
        render: { bloom: { enabled: true, strength: 99, radius: 0.4, threshold: 0.7 } },
      });
      expect(glow.render && getBloomEffect(glow.render).settings.strength).toBe(3);
    });

    // 9 & 10 — textures across all four channels, replace and clear
    it('stores, replaces and clears textures on every channel', async () => {
      const { id } = await lib.create({ name: 'Textured' });
      for (const channel of [0, 1, 2, 3]) {
        await lib.setTexture(id, channel, {
          ext: 'png',
          bytes: Buffer.from(`c${channel}`),
          width: 4,
          height: 4,
        });
      }
      const record = await lib.read(id);
      expect(record.channels.map((channel) => channel.ext)).toEqual(['png', 'png', 'png', 'png']);
      expect((await lib.readTexture(id, 2))?.bytes).toEqual(new Uint8Array(Buffer.from('c2')));

      await lib.setTexture(id, 0, {
        ext: 'jpg',
        bytes: Buffer.from('replaced'),
        width: 8,
        height: 8,
      });
      const replaced = await lib.readTexture(id, 0);
      expect(replaced?.ext).toBe('jpg');
      expect(replaced?.bytes).toEqual(new Uint8Array(Buffer.from('replaced')));

      await lib.clearTexture(id, 0);
      expect(await lib.readTexture(id, 0)).toBeNull();
      expect((await lib.read(id)).channels[0].ext).toBeNull();
    });

    // 11 — thumbnail (a preview is not an edit)
    it('stores a thumbnail without bumping updatedAt or revision', async () => {
      const created = await lib.create({ name: 'Preview' });
      const saved = await lib.setThumbnail(created.id, { ext: 'webp', bytes: Buffer.from('img') });
      expect(saved.thumbnail?.ext).toBe('webp');
      expect(saved.updatedAt).toBe(created.updatedAt);
      expect(saved.revision).toBe(created.revision);
      expect((await lib.readThumbnail(created.id))?.bytes).toEqual(
        new Uint8Array(Buffer.from('img')),
      );

      await lib.setThumbnail(created.id, { ext: 'png', bytes: Buffer.from('img2') });
      expect((await lib.readThumbnail(created.id))?.ext).toBe('png');
    });

    // 12 & 13 — import/export v2, rename and overwrite
    it('round-trips a collection through export -> parse -> import', async () => {
      const created = await lib.create({ name: 'Round Trip' });
      await lib.update(created.id, { fragment: FRAGMENT });
      await lib.savePreset(created.id, { name: 'Warm', values: {} });
      await lib.setTexture(created.id, 0, {
        ext: 'png',
        bytes: Buffer.from('pix'),
        width: 2,
        height: 2,
      });
      await lib.setThumbnail(created.id, { ext: 'webp', bytes: Buffer.from('thumb') });

      const bundle = buildCollectionBundle(await lib.exportAll());
      const parsed = parseBundle(JSON.parse(JSON.stringify(bundle)));
      if (!parsed.ok) throw new Error(parsed.errors.join('; '));

      await lib.remove(created.id);
      await lib.importPayloads(parsed.value, 'rename');

      const imported = await lib.read(created.id);
      expect(imported.fragment).toBe(FRAGMENT);
      expect(imported.presets.map((preset) => preset.name)).toEqual(['Warm']);
      expect((await lib.readTexture(created.id, 0))?.bytes).toEqual(
        new Uint8Array(Buffer.from('pix')),
      );
      expect((await lib.readThumbnail(created.id))?.bytes).toEqual(
        new Uint8Array(Buffer.from('thumb')),
      );
    });

    it('rename mode never overwrites, overwrite mode replaces the id holder', async () => {
      await lib.create({ name: 'Keep Me' });
      const renameResult = await lib.importPayloads([payloadOf('keep-me', 'Keep Me')], 'rename');
      expect(renameResult.imported[0]).toMatchObject({ id: 'keep-me-2', replaced: false });

      const overwrite = await lib.importPayloads(
        [withTexture(payloadOf('keep-me', 'Replaced'), 0)],
        'overwrite',
      );
      expect(overwrite.imported[0]).toMatchObject({ id: 'keep-me', replaced: true });
      expect((await lib.read('keep-me')).name).toBe('Replaced');
      expect((await lib.readTexture('keep-me', 0))?.bytes).toEqual(
        new Uint8Array(Buffer.from('a fake png image')),
      );
    });

    // 12 — import a v1 bundle (no project) via the parse path that synthesises one
    it('imports a shader-studio/v1 bundle, synthesising a project', async () => {
      const v1Shader = payloadOf('legacy', 'Legacy') as Partial<ShaderPayload>;
      delete v1Shader.project;
      const bundle = {
        format: LEGACY_BUNDLE_FORMAT,
        kind: 'shader',
        exportedAt: new Date().toISOString(),
        shader: { ...v1Shader, fragment: FRAGMENT },
      };
      const parsed = parseBundle(bundle);
      if (!parsed.ok) throw new Error(parsed.errors.join('; '));
      await lib.importPayloads(parsed.value, 'rename');

      const imported = await lib.read('legacy');
      expect(imported.fragment).toBe(FRAGMENT);
      expect(imagePass(imported.project).source).toBe(FRAGMENT);
    });

    // 14 — multipass project survives a restart
    it('persists a multipass project across a restart', async () => {
      const created = await lib.create({ name: 'Multi' });
      const withBuffer = addBuffer(created.project);
      const buffer = bufferPasses(withBuffer)[0];
      const wired = setChannelBinding(
        addFile(withBuffer, 'lib.glsl'),
        imagePass(withBuffer).id,
        0,
        {
          kind: 'buffer',
          passId: buffer.id,
          feedback: true,
        },
      );
      await lib.update(created.id, { project: wired });

      await lib.close();
      const reopened = new ShaderLibrary(harness.makeRepository());
      await reopened.init();
      try {
        expect((await reopened.read(created.id)).project).toEqual(wired);
      } finally {
        await reopened.close();
      }
    });

    // 15 — idempotent seeding
    it('seeds examples once, idempotently, and only when enabled', async () => {
      const source: PayloadSource = {
        listIds: async () => ['sample'],
        exportOne: async () => payloadOf('sample', 'Sample'),
      };

      await lib.installExamples(source, false);
      expect(await lib.list()).toEqual([]);

      await lib.installExamples(source, true);
      await lib.installExamples(source, true);
      expect((await lib.list()).map((entry) => entry.id)).toEqual(['sample']);

      await lib.remove('sample');
      await lib.installExamples(source, true);
      expect(await lib.list()).toEqual([]); // a deleted example does not come back
    });

    // 16 — rollback on a mid-transaction error
    it('rolls a failed transaction back completely', async () => {
      const repo = harness.makeRepository();
      const lib2 = new ShaderLibrary(repo);
      await lib2.init();
      try {
        await expect(
          repo.transaction(async (tx) => {
            await tx.insertShader({
              id: 'ghost',
              name: 'Ghost',
              description: '',
              author: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              revision: 1,
              projectJson: '{}',
              controlsJson: '[]',
              renderJson: '{}',
              channelsJson: '[]',
            });
            throw new Error('boom');
          }),
        ).rejects.toThrow();
        expect(await lib2.list()).toEqual([]);
      } finally {
        await lib2.close();
      }
    });

    // 17 — revision conflict
    it('detects a concurrent write via expectedRevision', async () => {
      const created = await lib.create({ name: 'Contended' });
      const first = await lib.update(created.id, { name: 'A', expectedRevision: created.revision });
      expect(first.revision).toBe(2);
      await expect(
        lib.update(created.id, { name: 'B', expectedRevision: created.revision }),
      ).rejects.toMatchObject({ code: 'conflict' });
      // Without an expectedRevision, last write wins.
      await expect(lib.update(created.id, { name: 'C' })).resolves.toMatchObject({ name: 'C' });
    });

    // 18 — migration from the file format (an in-memory legacy source)
    it('migrates a legacy library in one verified transaction', async () => {
      const legacy: ShaderPayload[] = [
        withTexture(payloadOf('one', 'One'), 0),
        {
          ...payloadOf('two', 'Two'),
          thumbnail: { ext: 'webp', updatedAt: new Date().toISOString(), data: WEBP },
        },
      ];
      const source: PayloadSource = {
        listIds: async () => legacy.map((payload) => payload.id),
        exportOne: async (id) => legacy.find((payload) => payload.id === id)!,
      };

      const summary = await lib.migrateLegacy(source);
      expect(summary).toEqual({ imported: 2, skipped: 0 });
      expect((await lib.list()).map((entry) => entry.id).sort()).toEqual(['one', 'two']);
      expect((await lib.readTexture('one', 0))?.bytes).toEqual(
        new Uint8Array(Buffer.from('a fake png image')),
      );
      expect((await lib.readThumbnail('two'))?.bytes).toEqual(
        new Uint8Array(Buffer.from('a fake webp preview')),
      );
    });

    // 19 — invalid / degenerate stored JSON must never crash the reader
    it('stays resilient to a corrupt project (io error or degraded, never a crash)', async () => {
      const { id } = await lib.create({ name: 'Corrupt' });
      await harness.corruptProjectJson(id);
      try {
        const record = await lib.read(id);
        // A degenerate project degrades to a valid one rather than throwing
        // (e.g. Postgres `jsonb` cannot hold invalid JSON in the first place).
        expect(record.project.passes.length).toBeGreaterThan(0);
      } catch (error) {
        expect(error).toBeInstanceOf(StorageError);
        expect((error as StorageError).code).toBe('io');
      }
    });

    // 20 — a missing asset degrades instead of crashing
    it('degrades gracefully when a channel points at a missing asset', async () => {
      const { id } = await lib.create({ name: 'Dangling' });
      await lib.setTexture(id, 0, {
        ext: 'png',
        bytes: Buffer.from('gone soon'),
        width: 2,
        height: 2,
      });
      await harness.removeAssetRow(id, 'texture:0');

      expect(await lib.readTexture(id, 0)).toBeNull();
      const payload = await lib.exportOne(id);
      expect(payload.channels[0].data).toBeNull();
    });

    // 21 — persistence across a restart
    it('persists shaders across a restart', async () => {
      const created = await lib.create({ name: 'Durable' });
      await lib.update(created.id, { fragment: FRAGMENT });
      await lib.close();

      const reopened = new ShaderLibrary(harness.makeRepository());
      await reopened.init();
      try {
        expect((await reopened.read(created.id)).fragment).toBe(FRAGMENT);
      } finally {
        await reopened.close();
      }
    });
  });
}
