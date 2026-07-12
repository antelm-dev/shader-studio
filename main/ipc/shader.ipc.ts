import { defineIpcModule, handle } from 'electron-ipc-module';

import type { ImportMode, ShaderParams } from '../../src/shared/model';
import {
  buildCollectionBundle,
  buildShaderBundle,
  parseBundle,
  validateImportMode,
} from '../../src/shared/validate';
import type { UpdateShaderPatch } from '../../src/app/core/shader-api';
import { ShaderStorage, StorageError } from '../../src/server/storage';

function stringArg(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new StorageError('invalid', `${name} must be a string`);
  return value;
}

function objectArg(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StorageError('invalid', `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function createShaderIpc(storage: ShaderStorage) {
  return defineIpcModule('shader', {
    list: handle(() => storage.list()),
    read: handle((_event, id: string) => storage.read(stringArg(id, 'id'))),
    create: handle((_event, input: { name: string; description?: string }) => {
      const body = objectArg(input, 'input');
      return storage.create({ name: body['name'], description: body['description'] });
    }),
    update: handle((_event, id: string, patch: UpdateShaderPatch) => {
      const body = objectArg(patch, 'patch');
      return storage.update(stringArg(id, 'id'), body as UpdateShaderPatch);
    }),
    duplicate: handle((_event, id: string, name?: string) =>
      storage.duplicate(stringArg(id, 'id'), name),
    ),
    remove: handle(async (_event, id: string) => storage.remove(stringArg(id, 'id'))),
    'save-preset': handle((_event, id: string, input: { name: string; values: ShaderParams }) =>
      storage.savePreset(
        stringArg(id, 'id'),
        objectArg(input, 'preset') as { name: unknown; values: unknown },
      ),
    ),
    'delete-preset': handle((_event, id: string, presetId: string) =>
      storage.deletePreset(stringArg(id, 'id'), stringArg(presetId, 'presetId')),
    ),
    'export-shader': handle(async (_event, id: string) =>
      buildShaderBundle(await storage.exportOne(stringArg(id, 'id'))),
    ),
    'export-all': handle(async () => buildCollectionBundle(await storage.exportAll())),
    'import-bundle': handle(async (_event, bundle: unknown, mode: ImportMode) => {
      const parsedMode = validateImportMode(mode);
      if (!parsedMode.ok)
        throw new StorageError('invalid', 'Invalid import mode', parsedMode.errors);
      const parsed = parseBundle(bundle);
      if (!parsed.ok)
        throw new StorageError('invalid', 'The bundle could not be imported', parsed.errors);
      return storage.importPayloads(parsed.value, parsedMode.value);
    }),
    'set-texture': handle(
      (
        _event,
        id: string,
        channel: number,
        input: { ext: string; bytes: Uint8Array; width: number; height: number },
      ) => {
        const body = objectArg(input, 'input');
        return storage.setTexture(stringArg(id, 'id'), channel, {
          ext: stringArg(body['ext'], 'ext'),
          bytes: Buffer.from(body['bytes'] as Uint8Array),
          width: body['width'] as number,
          height: body['height'] as number,
        });
      },
    ),
    'clear-texture': handle((_event, id: string, channel: number) =>
      storage.clearTexture(stringArg(id, 'id'), channel),
    ),
    'read-texture': handle(async (_event, id: string, channel: number) => {
      const texture = await storage.readTexture(stringArg(id, 'id'), channel);
      return texture ? { bytes: new Uint8Array(texture.bytes), ext: texture.ext } : null;
    }),
  });
}
