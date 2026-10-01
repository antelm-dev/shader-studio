import { ShaderLibrary, SYSTEM_SCOPE } from '@shadergrove/backend/library';
import { createLegacyReader } from '@shadergrove/backend/persistence/legacy';
import { PostgresRepository } from '@shadergrove/backend/persistence/postgres';
import type { ImportMode } from '@shadergrove/shared/model';

import { requireDatabaseUrl } from './require-database-url';

/**
 * Imports a legacy file library. It opens the source read-only, imports every
 * shader (with presets, project, textures and thumbnails), prints a summary and
 * exits non-zero on failure. It never deletes or modifies the source.
 */
export async function migrateFiles(source: string, mode: ImportMode): Promise<number> {
  const url = requireDatabaseUrl();
  if (!url) return 2;

  const library = new ShaderLibrary(
    new PostgresRepository({ connectionString: url }),
    SYSTEM_SCOPE,
  );
  await library.init();
  try {
    const reader = createLegacyReader(source);
    const ids = await reader.listIds();
    if (ids.length === 0) {
      console.error(`error: no shaders found under "${source}" (expected a shaders/ directory).`);
      return 1;
    }

    const payloads = [];
    let skipped = 0;
    for (const id of ids) {
      try {
        payloads.push(await reader.exportOne(id));
      } catch (error) {
        skipped += 1;
        console.warn(`  skipped unreadable shader "${id}": ${String(error)}`);
      }
    }

    const result = await library.importPayloads(payloads, mode);
    const replaced = result.imported.filter((entry) => entry.replaced).length;
    console.log(
      `Imported ${result.imported.length} shader(s) into PostgreSQL ` +
        `(${replaced} replaced, ${skipped} skipped). The source was left untouched.`,
    );
    return 0;
  } finally {
    await library.close();
  }
}
