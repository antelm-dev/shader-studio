import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WebContents } from 'electron';
import { defineIpcModule, handle } from 'electron-ipc-module';

import { PLUGIN_LIMITS, parsePluginPackage } from '@shadergrove/shared';
import type { StoredPlugin } from '@shadergrove/desktop-api/contracts';

/**
 * Installed local plugins, one file each under `<userData>/plugins`.
 *
 * The renderer never names a path: a file's name is a hash of the package id
 * the main process read out of the package itself, which also keeps an id like
 * `con` clear of Windows' reserved device names. What is stored is the package
 * text as picked plus the user's switch; the renderer revalidates the text on
 * every load, so a file edited or corrupted on disk comes back disabled rather
 * than trusted.
 */
export function createPluginFiles(dir: string) {
  const fileFor = (id: string) =>
    join(dir, `${createHash('sha256').update(id).digest('hex').slice(0, 32)}.json`);

  return {
    async list(): Promise<StoredPlugin[]> {
      const names = await readdir(dir).catch(() => [] as string[]);
      const stored: StoredPlugin[] = [];
      for (const name of names.filter((entry) => /^[0-9a-f]{32}\.json$/.test(entry))) {
        const record = await readFile(join(dir, name), 'utf8')
          .then((text) => JSON.parse(text) as unknown)
          .catch(() => null);
        if (isStoredPlugin(record)) stored.push(record);
      }
      return stored;
    },

    /** Stores a package under the id its own manifest declares; refuses one that does not validate. */
    async put(record: StoredPlugin): Promise<string> {
      if (!isStoredPlugin(record)) throw new Error('Not a plugin record');
      const parsed = parsePluginPackage(record.text);
      if (!parsed.ok) throw new Error(`Invalid plugin package: ${parsed.errors.join('; ')}`);
      const id = parsed.value.manifest.id;
      if (record.id !== id) throw new Error('The record id does not match its package');
      await mkdir(dir, { recursive: true });
      const path = fileFor(id);
      const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(record));
        await rename(temp, path);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
      return id;
    },

    async remove(id: string): Promise<void> {
      if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
        throw new Error('Not a plugin id');
      }
      await rm(fileFor(id), { force: true });
    },
  };
}

function isStoredPlugin(value: unknown): value is StoredPlugin {
  if (typeof value !== 'object' || value === null) return false;
  const { id, text, enabled, installedAt } = value as Record<string, unknown>;
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 64 &&
    typeof text === 'string' &&
    text.length <= PLUGIN_LIMITS.packageBytes &&
    typeof enabled === 'boolean' &&
    typeof installedAt === 'string' &&
    installedAt.length <= 40
  );
}

/**
 * `isMainWindow` gates every call: output and satellite windows render
 * shaders, they do not get to install or remove code.
 */
export function createPluginsIpc(dir: string, isMainWindow: (sender: WebContents) => boolean) {
  const files = createPluginFiles(dir);
  const guard = (sender: WebContents) => {
    if (!isMainWindow(sender)) throw new Error('Plugins are managed from the main window only');
  };

  return defineIpcModule('plugins', {
    list: handle(async (event): Promise<StoredPlugin[]> => {
      guard(event.sender);
      return files.list();
    }),
    put: handle(async (event, record: StoredPlugin): Promise<string> => {
      guard(event.sender);
      return files.put(record);
    }),
    remove: handle(async (event, id: string): Promise<void> => {
      guard(event.sender);
      await files.remove(id);
    }),
  });
}
