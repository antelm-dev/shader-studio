import { BrowserWindow, dialog, type OpenDialogOptions } from 'electron';
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { defineIpcModule, handle } from 'electron-ipc-module';

import { parseBundle } from '../../src/shared/validate';

// A textured shader's bundle inlines its channel images as base64, and a
// collection can hold many shaders — comfortably larger than the old
// text-only limit.
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
export type DialogResult<T> = { status: 'ok'; value: T } | { status: 'cancelled' } | { status: 'error'; message: string };

async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  const temp = join(dirname(path), `.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temp, data);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function createFilesIpc() {
  return defineIpcModule('files', {
    'open-bundle': handle(async (event): Promise<DialogResult<{ name: string; bundle: unknown }>> => {
      const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const options: OpenDialogOptions = { properties: ['openFile'], filters: [{ name: 'Shader Studio bundle', extensions: ['json'] }] };
      const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      if (picked.canceled || !picked.filePaths[0]) return { status: 'cancelled' };
      try {
        const data = await readFile(picked.filePaths[0]);
        if (data.byteLength > MAX_IMPORT_BYTES) return { status: 'error', message: 'The selected file is larger than 8 MB' };
        const bundle: unknown = JSON.parse(data.toString('utf8'));
        const parsed = parseBundle(bundle);
        if (!parsed.ok) return { status: 'error', message: parsed.errors[0] ?? 'Invalid shader bundle' };
        return { status: 'ok', value: { name: picked.filePaths[0].split(/[\\/]/).pop() ?? 'bundle', bundle } };
      } catch (error) {
        return { status: 'error', message: error instanceof Error ? error.message : String(error) };
      }
    }),
    'save-bundle': handle(async (event, filename: string, bundle: unknown): Promise<DialogResult<null>> => {
      const parsed = parseBundle(bundle);
      if (!parsed.ok) return { status: 'error', message: parsed.errors[0] ?? 'Invalid shader bundle' };
      const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const options = { defaultPath: basename(filename), filters: [{ name: 'Shader Studio bundle', extensions: ['json'] }] };
      const picked = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
      if (picked.canceled || !picked.filePath) return { status: 'cancelled' };
      try {
        await atomicWrite(picked.filePath, JSON.stringify(bundle, null, 2));
        return { status: 'ok', value: null };
      } catch (error) {
        return { status: 'error', message: error instanceof Error ? error.message : String(error) };
      }
    }),
    'save-png': handle(async (event, filename: string, bytes: Uint8Array): Promise<DialogResult<null>> => {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > 100 * 1024 * 1024) {
        return { status: 'error', message: 'Invalid or oversized PNG data' };
      }
      const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const options = { defaultPath: basename(filename), filters: [{ name: 'PNG image', extensions: ['png'] }] };
      const picked = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
      if (picked.canceled || !picked.filePath) return { status: 'cancelled' };
      try {
        await atomicWrite(picked.filePath, bytes);
        return { status: 'ok', value: null };
      } catch (error) {
        return { status: 'error', message: error instanceof Error ? error.message : String(error) };
      }
    }),
  });
}
