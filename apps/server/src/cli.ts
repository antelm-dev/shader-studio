/**
 * Deliberate, one-shot maintenance commands for the PostgreSQL deployment.
 * Neither runs automatically on container start — you invoke them by hand.
 *
 *   shader-studio migrate-files --source=<path> [--mode=rename|overwrite]
 *
 * Imports a legacy file library. It opens the source read-only, imports every
 * shader (with presets, project, textures and thumbnails), prints a summary and
 * exits non-zero on failure. It never deletes or modifies the source:
 *
 *   docker compose run --rm shader-studio \
 *     node dist/shader-studio/cli.mjs migrate-files --source=/legacy-data
 *
 *   shader-studio claim-shaders --email=<address> [--dry-run]
 *
 * Hands the shaders that predate authentication — the ones the ownership
 * migration backfilled to the system account — to a real user, who must already
 * have signed up. Bundled examples are left alone: they are templates, and
 * belong to nobody in particular:
 *
 *   docker compose run --rm shader-studio \
 *     node dist/shader-studio/cli.mjs claim-shaders --email=you@example.com
 */

import { ShaderLibrary, SYSTEM_SCOPE } from '@shader-studio/backend/library';
import { createLegacyReader } from '@shader-studio/backend/persistence/legacy';
import {
  claimSystemShaders,
  PostgresRepository,
} from '@shader-studio/backend/persistence/postgres';
import type { ImportMode } from '@shader-studio/shared/model';

interface Args {
  command: string | undefined;
  source: string | undefined;
  email: string | undefined;
  dryRun: boolean;
  mode: ImportMode;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: undefined,
    source: undefined,
    email: undefined,
    dryRun: false,
    mode: 'rename',
  };
  for (const arg of argv) {
    if (arg.startsWith('--source=')) args.source = arg.slice('--source='.length);
    else if (arg.startsWith('--email=')) args.email = arg.slice('--email='.length).trim();
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg.startsWith('--mode=')) {
      const mode = arg.slice('--mode='.length);
      args.mode = mode === 'overwrite' ? 'overwrite' : 'rename';
    } else if (!arg.startsWith('--') && args.command === undefined) args.command = arg;
  }
  return args;
}

function usage(): void {
  console.error(
    'Usage:\n' +
      '  shader-studio migrate-files --source=<path> [--mode=rename|overwrite]\n\n' +
      '    Imports a legacy file library (a folder containing a shaders/ directory)\n' +
      '    into the PostgreSQL database named by DATABASE_URL. The source is opened\n' +
      '    read-only and never modified.\n\n' +
      '  shader-studio claim-shaders --email=<address> [--dry-run]\n\n' +
      '    Moves the shaders that predate authentication from the system account\n' +
      '    to the named user, who must already have signed up. Bundled examples\n' +
      '    stay where they are — they are templates, not anyone’s documents.',
  );
}

async function claimShaders(email: string, dryRun: boolean): Promise<number> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('error: DATABASE_URL must be set to the target PostgreSQL database.');
    return 2;
  }

  const result = await claimSystemShaders(url, email, { dryRun });
  switch (result.status) {
    case 'no-such-user':
      console.error(
        `error: no account for "${email}". Sign up in the app first, then run this again.`,
      );
      return 1;
    case 'nothing-to-claim':
      console.log('Nothing to claim: no shaders are left under the system account.');
      return 0;
    case 'would-claim':
      console.log(`Would move ${result.count} shader(s) to ${result.owner} <${email}>.`);
      return 0;
    case 'claimed':
      console.log(`Moved ${result.count} shader(s) to ${result.owner} <${email}>.`);
      return 0;
  }
}

async function migrateFiles(source: string, mode: ImportMode): Promise<number> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('error: DATABASE_URL must be set to the target PostgreSQL database.');
    return 2;
  }

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

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'claim-shaders') {
    if (!args.email) {
      console.error('error: --email=<address> is required.\n');
      usage();
      return 2;
    }
    return claimShaders(args.email, args.dryRun);
  }

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
    console.error('Command failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
