/**
 * Writes an export runtime's project into a new folder the user chose the
 * parent of.
 *
 * Everything the renderer sends is checked again here: the stem is reduced to
 * a leaf name, every path must be one of the few a runtime writes, and the
 * total size is bounded. Nothing existing is overwritten — a taken name gets
 * a numbered sibling — and the files are written into a hidden staging folder
 * that is renamed into place only once every write succeeded, so a failure or
 * a crash never leaves a half-written project under the final name.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const MAX_PROJECT_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 8;
const ALLOWED_PATH = /^(?:index\.html|project\.json|textures\/channel[0-3]\.(?:png|jpg|webp))$/;

export interface ProjectFile {
  path: string;
  bytes: Uint8Array;
}

/** Whatever the project was called, reduced to something that is only ever a folder name. */
export function sanitizeProjectStem(stem: unknown): string {
  const cleaned = String(stem ?? '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
  return cleaned || 'shader-project';
}

/** The files as the renderer sent them, or why they are refused. */
export function validateProjectFiles(input: unknown): ProjectFile[] | string {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_FILES) {
    return 'A project has 1 to 8 files';
  }
  const seen = new Set<string>();
  let total = 0;
  const files: ProjectFile[] = [];
  for (const entry of input) {
    const { path, bytes } = (entry ?? {}) as { path?: unknown; bytes?: unknown };
    if (typeof path !== 'string' || !ALLOWED_PATH.test(path) || seen.has(path)) {
      return 'A project file has a path this app does not write';
    }
    if (!(bytes instanceof Uint8Array)) return 'A project file has no bytes';
    seen.add(path);
    total += bytes.byteLength;
    if (total > MAX_PROJECT_BYTES) return 'The project is too large';
    files.push({ path, bytes });
  }
  const index = files.find((file) => file.path === 'index.html');
  if (!index || index.bytes[0] !== 0x3c) return 'A project needs its index.html';
  const project = files.find((file) => file.path === 'project.json');
  if (project) {
    try {
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(project.bytes));
      if (parsed?.file !== 'index.html') return 'project.json must point at index.html';
    } catch {
      return 'project.json is not valid JSON';
    }
  }
  return files;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Write `files` into a new folder `<parent>/<stem>` (or `<stem>-2`, … if that
 * is taken) and return its path. The folder appears only complete.
 */
export async function writeProjectFolder(
  parent: string,
  stem: string,
  files: readonly ProjectFile[],
): Promise<string> {
  const leaf = sanitizeProjectStem(stem);
  let target = join(parent, leaf);
  for (let suffix = 2; await exists(target); suffix++) {
    if (suffix > 99) throw new Error('Too many projects with this name in that folder');
    target = join(parent, `${leaf}-${suffix}`);
  }
  const staging = join(parent, `.${leaf}.${randomBytes(6).toString('hex')}.partial`);
  await mkdir(staging);
  try {
    for (const file of files) {
      const path = join(staging, ...file.path.split('/'));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.bytes, { flag: 'wx' });
    }
    // Checked again just before the rename: another writer may have taken the name meanwhile.
    if (await exists(target)) throw new Error('The destination folder appeared while writing');
    await rename(staging, target);
    return target;
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
