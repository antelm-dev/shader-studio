import type { ImportMode } from '@shadergrove/shared/model';

export interface Args {
  command: string | undefined;
  source: string | undefined;
  email: string | undefined;
  dryRun: boolean;
  mode: ImportMode;
}

export function parseArgs(argv: string[]): Args {
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
