import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { Arch, Platform, build as buildInstaller } from 'electron-builder';

import { createLogger } from '../../../scripts/_lib/logger.mjs';

const log = createLogger('desktop');
const root = resolve(import.meta.dirname, '../../..');
const require = createRequire(import.meta.url);
const electronVersion = require('electron/package.json').version;

const commands = {
  clean: ['pnpm', 'run', 'clean'],
  ipc: ['pnpm', 'run', 'gen:ipc'],
  rendererTypes: ['pnpm', '--filter', '@shader-studio/renderer', 'typecheck'],
  backendTypes: ['pnpm', '--filter', '@shader-studio/backend', 'typecheck'],
  mainTypes: ['pnpm', 'exec', 'tsc', '--noEmit', '-p', 'tsconfig.main.json'],
  preloadTypes: ['pnpm', 'exec', 'tsc', '--noEmit', '-p', 'tsconfig.preload.json'],
  renderer: ['pnpm', '--filter', '@shader-studio/renderer', 'build:desktop'],
  main: ['pnpm', 'run', 'build:main'],
};

const modes = new Set(['build', 'pack', 'dist']);
const options = parseArguments(process.argv.slice(2));

await buildDesktop();

if (options.mode !== 'build') {
  await packageDesktop();
}

async function buildDesktop() {
  for (const [name, command] of Object.entries(commands)) {
    log.info(`${name}: ${command.join(' ')}`);
    await run(command);
  }
}

async function packageDesktop() {
  const platform = options.platform ?? Platform.current();
  const target = options.mode === 'pack' ? 'dir' : null;
  const arch = options.arch ? [options.arch] : [];

  log.info(`package: ${platform.name}${target ? ` (${target})` : ''}`);

  const artifacts = await buildInstaller({
    projectDir: root,
    config: {
      extends: 'apps/desktop/electron-builder.yml',
      electronVersion,
    },
    targets: platform.createTarget(target, ...arch),
    publish: process.env.ELECTRON_BUILDER_PUBLISH ?? 'never',
  });

  for (const artifact of artifacts) {
    log.info(`Created ${artifact}`);
  }
}

function run([command, ...args]) {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const executable = isWindows && command === 'pnpm' ? 'pnpm.cmd' : command;
    const child = spawn(executable, args, {
      stdio: 'inherit',
      // Node >= 18.20.2/20.12.2/22 requires shell: true to spawn .cmd/.bat files on
      // Windows (CVE-2024-27980). Safe here since these commands are hardcoded, not
      // user input.
      shell: isWindows && executable.endsWith('.cmd'),
      env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '1' },
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`${command} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`),
        );
    });
  });
}

function parseArguments(args) {
  const mode = args.shift() ?? 'build';
  if (!modes.has(mode)) {
    usage(`Unknown mode: ${mode}`);
  }

  let platform;
  let arch;

  for (const argument of args) {
    if (argument === '--win') platform = Platform.WINDOWS;
    else if (argument === '--mac') platform = Platform.MAC;
    else if (argument === '--linux') platform = Platform.LINUX;
    else if (argument.startsWith('--arch=')) arch = parseArch(argument.slice(7));
    else usage(`Unknown option: ${argument}`);
  }

  return { mode, platform, arch };
}

function parseArch(value) {
  const architectures = {
    x64: Arch.x64,
    arm64: Arch.arm64,
    ia32: Arch.ia32,
    armv7l: Arch.armv7l,
  };

  if (!(value in architectures)) {
    usage(`Unsupported architecture: ${value}`);
  }

  return architectures[value];
}

function usage(error) {
  log.error(error);
  log.error(
    'Usage: node scripts/build.mjs [build|pack|dist] [--win|--mac|--linux] [--arch=x64|arm64|ia32|armv7l]',
  );
  process.exit(1);
}
