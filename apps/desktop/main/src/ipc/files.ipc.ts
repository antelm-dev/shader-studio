import { BrowserWindow, dialog, type OpenDialogOptions } from 'electron';
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { defineIpcModule, handle } from 'electron-ipc-module';

import { parseBundle } from '@shader-studio/shared/validate';
import type { DialogResult } from '@shader-studio/desktop-api/contracts';

// A textured shader's bundle inlines its channel images as base64, and a
// collection can hold many shaders — comfortably larger than the old
// text-only limit.
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
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

// ---------------------------------------------------------------------------
// Image sequences
// ---------------------------------------------------------------------------

/**
 * An export in progress: a folder the user chose, and the frames written into it
 * so far.
 *
 * A sequence is thousands of files, so it cannot be a save dialog per frame —
 * but that is exactly the shape a renderer could abuse. So the renderer never
 * names a file and never sees a path: it opens a session, and from then on it
 * may only say "here are the bytes of frame *n*". The folder, the file name and
 * the extension are all decided here, from a stem stripped of everything that
 * could climb out of the directory the user picked.
 */
interface SequenceSession {
  /** The window that opened it. Another window's frames are not welcome. */
  readonly sender: number;
  readonly directory: string;
  readonly stem: string;
  readonly padding: number;
  readonly written: string[];
}

const sequences = new Map<string, SequenceSession>();

/**
 * A video export in progress: the path the user picked, held until the renderer
 * either commits the encoded bytes or aborts. Nothing is written until commit —
 * cancelling mid-encode leaves no half-file behind.
 */
interface VideoSession {
  readonly sender: number;
  readonly path: string;
}

const videos = new Map<string, VideoSession>();

/** No frame of a shader render has any business being this big; a 4K PNG is a few MB. */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_SEQUENCE_FRAMES = 100_000;
/** A few minutes of 4K VP9 can land here; past this the renderer should have streamed. */
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;

/** Whatever the shader was called, reduced to something that is only ever a file name. */
function sanitizeStem(stem: string): string {
  const cleaned = stem
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .slice(0, 64);
  return cleaned || 'shader';
}

export function createFilesIpc() {
  return defineIpcModule('files', {
    'begin-sequence': handle(
      async (
        event,
        stem: string,
        padding: number,
      ): Promise<DialogResult<{ id: string; directory: string }>> => {
        const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
        const options: OpenDialogOptions = {
          title: 'Choose a folder for the image sequence',
          properties: ['openDirectory', 'createDirectory'],
        };
        const picked = owner
          ? await dialog.showOpenDialog(owner, options)
          : await dialog.showOpenDialog(options);
        if (picked.canceled || !picked.filePaths[0]) return { status: 'cancelled' };

        const id = randomBytes(16).toString('hex');
        sequences.set(id, {
          sender: event.sender.id,
          directory: picked.filePaths[0],
          stem: sanitizeStem(stem),
          padding: Math.min(Math.max(Math.round(padding) || 4, 4), 9),
          written: [],
        });

        // A window closed mid-capture never sends `end-sequence`. Without this the
        // session — and the list of paths it is holding — would outlive the app's
        // interest in it.
        event.sender.once('destroyed', () => sequences.delete(id));

        return { status: 'ok', value: { id, directory: picked.filePaths[0] } };
      },
    ),
    'write-frame': handle(
      async (event, id: string, index: number, bytes: Uint8Array): Promise<DialogResult<null>> => {
        const session = sequences.get(id);
        if (!session || session.sender !== event.sender.id) {
          return { status: 'error', message: 'That image sequence is not open' };
        }
        if (!Number.isInteger(index) || index < 0 || index >= MAX_SEQUENCE_FRAMES) {
          return { status: 'error', message: `Frame ${index} is not a frame number` };
        }
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_FRAME_BYTES) {
          return { status: 'error', message: 'Invalid or oversized frame data' };
        }

        const name = `${session.stem}-${String(index).padStart(session.padding, '0')}.png`;
        const path = join(session.directory, name);
        try {
          // Not an atomic write: a sequence is thousands of frames, and the
          // temp-file-then-rename dance would double the I/O for a file whose
          // half-written state is only ever visible inside a capture the user is
          // watching a progress bar for. A cancelled capture removes them all.
          await writeFile(path, bytes);
          session.written.push(path);
          return { status: 'ok', value: null };
        } catch (error) {
          return {
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          };
        }
      },
    ),
    'end-sequence': handle(
      async (
        event,
        id: string,
        cancelled: boolean,
      ): Promise<DialogResult<{ directory: string; frames: number }>> => {
        const session = sequences.get(id);
        if (!session || session.sender !== event.sender.id) {
          return { status: 'error', message: 'That image sequence is not open' };
        }
        sequences.delete(id);

        // A cancelled capture leaves no half-sequence behind: a folder of frames
        // that stop in the middle is worse than no folder at all, because it
        // looks like a finished export until you play it.
        if (cancelled) {
          await Promise.all(session.written.map((path) => rm(path, { force: true })));
          return { status: 'cancelled' };
        }

        return {
          status: 'ok',
          value: { directory: session.directory, frames: session.written.length },
        };
      },
    ),
    'open-bundle': handle(
      async (event): Promise<DialogResult<{ name: string; bundle: unknown }>> => {
        const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
        const options: OpenDialogOptions = {
          properties: ['openFile'],
          filters: [{ name: 'Shader Studio bundle', extensions: ['json'] }],
        };
        const picked = owner
          ? await dialog.showOpenDialog(owner, options)
          : await dialog.showOpenDialog(options);
        if (picked.canceled || !picked.filePaths[0]) return { status: 'cancelled' };
        try {
          const data = await readFile(picked.filePaths[0]);
          if (data.byteLength > MAX_IMPORT_BYTES)
            return { status: 'error', message: 'The selected file is larger than 8 MB' };
          const bundle: unknown = JSON.parse(data.toString('utf8'));
          const parsed = parseBundle(bundle);
          if (!parsed.ok)
            return { status: 'error', message: parsed.errors[0] ?? 'Invalid shader bundle' };
          return {
            status: 'ok',
            value: { name: picked.filePaths[0].split(/[\\/]/).pop() ?? 'bundle', bundle },
          };
        } catch (error) {
          return {
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          };
        }
      },
    ),
    'save-bundle': handle(
      async (event, filename: string, bundle: unknown): Promise<DialogResult<null>> => {
        const parsed = parseBundle(bundle);
        if (!parsed.ok)
          return { status: 'error', message: parsed.errors[0] ?? 'Invalid shader bundle' };
        const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
        const options = {
          defaultPath: basename(filename),
          filters: [{ name: 'Shader Studio bundle', extensions: ['json'] }],
        };
        const picked = owner
          ? await dialog.showSaveDialog(owner, options)
          : await dialog.showSaveDialog(options);
        if (picked.canceled || !picked.filePath) return { status: 'cancelled' };
        try {
          await atomicWrite(picked.filePath, JSON.stringify(bundle, null, 2));
          return { status: 'ok', value: null };
        } catch (error) {
          return {
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          };
        }
      },
    ),
    'save-png': handle(
      async (event, filename: string, bytes: Uint8Array): Promise<DialogResult<null>> => {
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > 100 * 1024 * 1024) {
          return { status: 'error', message: 'Invalid or oversized PNG data' };
        }
        const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
        const options = {
          defaultPath: basename(filename),
          filters: [{ name: 'PNG image', extensions: ['png'] }],
        };
        const picked = owner
          ? await dialog.showSaveDialog(owner, options)
          : await dialog.showSaveDialog(options);
        if (picked.canceled || !picked.filePath) return { status: 'cancelled' };
        try {
          await atomicWrite(picked.filePath, bytes);
          return { status: 'ok', value: null };
        } catch (error) {
          return {
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          };
        }
      },
    ),
    'begin-video': handle(
      async (event, stem: string): Promise<DialogResult<{ id: string; path: string }>> => {
        const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
        const options = {
          title: 'Save video',
          defaultPath: `${sanitizeStem(stem)}.webm`,
          filters: [{ name: 'WebM video', extensions: ['webm'] }],
        };
        const picked = owner
          ? await dialog.showSaveDialog(owner, options)
          : await dialog.showSaveDialog(options);
        if (picked.canceled || !picked.filePath) return { status: 'cancelled' };

        const id = randomBytes(16).toString('hex');
        videos.set(id, { sender: event.sender.id, path: picked.filePath });
        event.sender.once('destroyed', () => videos.delete(id));

        return { status: 'ok', value: { id, path: picked.filePath } };
      },
    ),
    'commit-video': handle(
      async (event, id: string, bytes: Uint8Array): Promise<DialogResult<{ path: string }>> => {
        const session = videos.get(id);
        if (!session || session.sender !== event.sender.id) {
          return { status: 'error', message: 'That video export is not open' };
        }
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_VIDEO_BYTES) {
          return { status: 'error', message: 'Invalid or oversized video data' };
        }
        videos.delete(id);
        try {
          await atomicWrite(session.path, bytes);
          return { status: 'ok', value: { path: session.path } };
        } catch (error) {
          return {
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          };
        }
      },
    ),
    'abort-video': handle(async (event, id: string): Promise<DialogResult<null>> => {
      const session = videos.get(id);
      if (!session || session.sender !== event.sender.id) {
        return { status: 'error', message: 'That video export is not open' };
      }
      videos.delete(id);
      return { status: 'ok', value: null };
    }),
  });
}
