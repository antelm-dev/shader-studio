/**
 * A read-only view over the old file-backed library, reused for two jobs: the
 * one-time import of an existing `userData/library` (or a `--source` folder), and
 * reading the bundled `examples/` folder for seeding — both are stored in the
 * exact same on-disk layout. It wraps `ShaderStorage` but exposes only
 * `listIds`/`exportOne`, so no host code can accidentally write through it.
 */

import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

import type { PayloadSource } from '../../library/shader-library';
import { ShaderStorage } from '../../storage/shader-storage';

/**
 * @param dir A directory that contains a `shaders/` subfolder (a data dir or the
 *            examples dir). Seeding is disabled; nothing is written.
 */
export function createLegacyReader(dir: string): PayloadSource {
  const store = new ShaderStorage({
    dataDir: dir,
    examplesDir: join(dir, '__no_examples__'),
    seed: false,
  });
  return {
    listIds: () => store.listIds(),
    exportOne: (id) => store.exportOne(id),
  };
}

/** True when `dir` holds a legacy library (a non-empty `shaders/` folder). */
export async function legacyLibraryExists(dir: string): Promise<boolean> {
  try {
    await access(join(dir, 'shaders'), constants.F_OK);
    return (await createLegacyReader(dir).listIds()).length > 0;
  } catch {
    return false;
  }
}
