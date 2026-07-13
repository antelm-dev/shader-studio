import { spawn } from 'node:child_process';

import { Arch, Platform, build as buildInstaller } from 'electron-builder';

const commands = {
  clean: ['node', 'scripts/clean.mjs'],
  ipc: ['node', 'scripts/gen-ipc.mjs'],
  types: ['pnpm', 'exec', 'tsc', '-p', 'tsconfig.app.json', '--noEmit'],
  testsTypes: ['pnpm', 'exec', 'tsc', '-p', 'tsconfig.spec.json', '--noEmit'],
  mainTypes: ['pnpm', 'exec', 'tsc', '--noEmit', '-p', 'tsconfig.main.json'],
  preloadTypes: ['pnpm', 'exec', 'tsc', '--noEmit', '-p', 'tsconfig.preload.json'],
  renderer: ['pnpm', 'exec', 'ng', 'run', 'shader-studio:desktop:production'],
  main: ['pnpm', 'exec', 'rollup', '-c', '--environment', 'NODE_ENV:production'],
};

const modes = new Set(['build', 'pack', 'dist']);
const options = parseArguments(process.argv.slice(2));

await buildDesktop();

if (options.mode !== 'build') {
  await packageDesktop();
}

async function buildDesktop() {
  for (const [name, command] of Object.entries(commands)) {
    console.log(`\n\x1b[36m[desktop:${name}]\x1b[0m ${command.join(' ')}`);
    await run(command);
  }
}

async function packageDesktop() {
  const platform = options.platform ?? Platform.current();
  const target = options.mode === 'pack' ? 'dir' : null;
  const arch = options.arch ? [options.arch] : [];

  console.log(`\n\x1b[36m[desktop:package]\x1b[0m ${platform.name}${target ? ` (${target})` : ''}`);

  const artifacts = await buildInstaller({
    targets: platform.createTarget(target, ...arch),
    publish: process.env.ELECTRON_BUILDER_PUBLISH ?? 'never',
  });

  for (const artifact of artifacts) {
    console.log(`\x1b[32mCreated\x1b[0m ${artifact}`);
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
  console.error(`\n${error}\n`);
  console.error(
    'Usage: node scripts/build.mjs [build|pack|dist] [--win|--mac|--linux] [--arch=x64|arm64|ia32|armv7l]',
  );
  process.exit(1);
}
