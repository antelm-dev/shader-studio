/**
 * Generic, file-system-backed primitives shared by every store in this
 * package: per-key write serialization, atomic single-file writes, tolerant
 * JSON reads, and safe path scoping. Nothing here knows about shaders,
 * projects, or presets — that domain logic lives in `shader-storage.ts` and
 * its sibling stores.
 */

import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { StorageError } from './storage-error';

/** Serializes async work per key, so concurrent calls for the same key run one after another. */
export class KeyedLock {
  private readonly pending = new Map<string, Promise<unknown>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(key) ?? Promise.resolve();
    const current = previous.then(work, work);
    this.pending.set(
      key,
      current.catch(() => undefined),
    );
    try {
      return await current;
    } finally {
      if (this.pending.get(key) === current) this.pending.delete(key);
    }
  }
}

/** Writes via a temp file + rename, so a reader never observes a partial write. */
export async function writeFileAtomic(file: string, contents: string | Uint8Array): Promise<void> {
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

export async function readJson(file: string): Promise<unknown> {
  const raw = await fs.readFile(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new StorageError('io', `${path.basename(file)} is not valid JSON`, [String(error)]);
  }
}

/**
 * Same as `readJson`, but a missing file or invalid JSON resolves to
 * `undefined` rather than throwing. Used where a corrupt or absent file must
 * degrade to a caller-supplied fallback rather than take the whole record down.
 */
export async function readOptionalJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolves `id` onto a child of `root`, rejecting anything that would escape it (e.g. via `..`). */
export function resolveScoped(root: string, id: string): string {
  const dir = path.resolve(root, id);
  const rootWithSep = root + path.sep;
  if (!dir.startsWith(rootWithSep)) {
    throw new StorageError('invalid', `Invalid id "${id}"`);
  }
  return dir;
}
