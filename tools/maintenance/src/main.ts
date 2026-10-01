/**
 * Deliberate, one-shot maintenance commands for the PostgreSQL deployment.
 * Neither runs automatically on container start — you invoke them by hand.
 *
 *   shadergrove migrate-files --source=<path> [--mode=rename|overwrite]
 *
 *   docker compose run --rm shader-studio \
 *     node dist/shadergrove/cli.mjs migrate-files --source=/legacy-data
 *
 *   shadergrove claim-shaders --email=<address> [--dry-run]
 *
 *   docker compose run --rm shader-studio \
 *     node dist/shadergrove/cli.mjs claim-shaders --email=you@example.com
 *
 * Each command lives in commands/; this file only parses and dispatches.
 */

import { parseArgs } from './args';
import { claimShaders } from './commands/claim-shaders';
import { migrateFiles } from './commands/migrate-files';

function usage(): void {
  console.error(
    'Usage:\n' +
      '  shadergrove migrate-files --source=<path> [--mode=rename|overwrite]\n\n' +
      '    Imports a legacy file library (a folder containing a shaders/ directory)\n' +
      '    into the PostgreSQL database named by DATABASE_URL. The source is opened\n' +
      '    read-only and never modified.\n\n' +
      '  shadergrove claim-shaders --email=<address> [--dry-run]\n\n' +
      '    Moves the shaders that predate authentication from the system account\n' +
      '    to the named user, who must already have signed up. Bundled examples\n' +
      '    stay where they are — they are templates, not anyone’s documents.',
  );
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
