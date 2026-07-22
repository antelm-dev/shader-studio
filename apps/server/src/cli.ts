/**
 * `shader-studio migrate-files --source=<path> [--mode=rename|overwrite]`
 *
 * A one-shot, explicit import of a legacy file library into PostgreSQL, for the
 * Docker deployment. It opens the source read-only, imports every shader (with
 * presets, project, textures and thumbnails), prints a summary, and exits
 * non-zero on failure. It never deletes or modifies the source, and it is never
 * run automatically on container start — you invoke it deliberately, e.g.:
 *
 *   docker compose run --rm shader-studio \
 *     node dist/shader-studio/cli.mjs migrate-files --source=/legacy-data
 */

import { ShaderLibrary } from '@shader-studio/backend/library';
import { createLegacyReader } from '@shader-studio/backend/persistence/legacy';
import { PostgresRepository } from '@shader-studio/backend/persistence/postgres';
import type { ImportMode } from '@shader-studio/shared/model';

interface Args {
  command: string | undefined;
  source: string | undefined;
  mode: ImportMode;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: undefined, source: undefined, mode: 'rename' };
  for (const arg of argv) {
    if (arg.startsWith('--source=')) args.source = arg.slice('--source='.length);
    else if (arg.startsWith('--mode=')) {
      const mode = arg.slice('--mode='.length);
      args.mode = mode === 'overwrite' ? 'overwrite' : 'rename';
    } else if (!arg.startsWith('--') && args.command === undefined) args.command = arg;
  }
  return args;
}

function usage(): void {
  console.error(
    'Usage: shader-studio migrate-files --source=<path> [--mode=rename|overwrite]\n\n' +
      '  Imports a legacy file library (a folder containing a shaders/ directory)\n' +
      '  into the PostgreSQL database named by DATABASE_URL. The source is opened\n' +
      '  read-only and never modified.',
  );
}

async function migrateFiles(source: string, mode: ImportMode): Promise<number> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('error: DATABASE_URL must be set to the target PostgreSQL database.');
    return 2;
  }

  const library = new ShaderLibrary(new PostgresRepository({ connectionString: url }));
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

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command !== 'migrate-files') {
    usage();
    return 2;
  }
  if (!args.source) {
    console.error('error: --source=<path> is required.\n');
    usage();
    return 2;
  }
  return migrateFiles(args.source, args.mode);
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('Migration failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
