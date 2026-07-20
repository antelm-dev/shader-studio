import { BrowserWindow, dialog, type OpenDialogOptions } from 'electron';
import { access, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { defineIpcModule, handle } from 'electron-ipc-module';

import { ShaderStorage } from '../../../../server/src/storage';

export type MigrationResult =
  | { status: 'ok'; imported: number; skipped: number }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function createMigrationIpc(storage: ShaderStorage, markerPath: string) {
  return defineIpcModule('migration', {
    pending: handle(async () => !(await exists(markerPath))),
    decline: handle(async () => {
      await writeFile(markerPath, 'declined\n', 'utf8');
    }),
    select: handle(async (event): Promise<MigrationResult> => {
      const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const options: OpenDialogOptions = {
        properties: ['openDirectory'],
        title: 'Choose an existing Shader Studio data folder',
      };
      const picked = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
      const selected = picked.filePaths[0];
      if (picked.canceled || !selected) return { status: 'cancelled' };

      try {
        const dataDir =
          basename(selected).toLowerCase() === 'shaders' ? dirname(selected) : selected;
        if (!(await exists(join(dataDir, 'shaders')))) {
          return {
            status: 'error',
            message: 'The selected folder does not contain a shaders directory',
          };
        }
        const source = new ShaderStorage({
          dataDir,
          examplesDir: join(dataDir, '__no_examples__'),
          seed: false,
        });
        await source.init();
        const ids = await source.listIds();
        const payloads = [];
        let skipped = 0;
        for (const id of ids) {
          try {
            payloads.push(await source.exportOne(id));
          } catch {
            skipped += 1;
          }
        }
        const result = await storage.importPayloads(payloads, 'overwrite');
        await writeFile(
          markerPath,
          JSON.stringify({ importedAt: new Date().toISOString(), source: dataDir }),
          'utf8',
        );
        return { status: 'ok', imported: result.imported.length, skipped };
      } catch (error) {
        return { status: 'error', message: error instanceof Error ? error.message : String(error) };
      }
    }),
  });
}
