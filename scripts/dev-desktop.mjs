import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const commands = [
  {
    name: 'angular',
    color: '\x1b[34m',
    entry: require.resolve('@angular/cli/bin/ng.js'),
    args: ['run', 'shader-studio:desktop-serve:development'],
    stdin: 'ignore',
  },
  {
    name: 'rollup',
    color: '\x1b[35m',
    entry: require.resolve('rollup/dist/bin/rollup'),
    args: ['-c', '--environment', 'NODE_ENV:development', '--watch'],
    stdin: 'inherit',
  },
];

const children = new Map();
let stopping = false;
let exitCode = 0;

for (const command of commands) {
  console.log(`${command.color}[${command.name}]\x1b[0m ${command.args.join(' ')}`);

  const child = spawn(process.execPath, [command.entry, ...command.args], {
    stdio: [command.stdin, 'inherit', 'inherit'],
    env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '1' },
  });

  children.set(command.name, child);

  child.once('error', (error) => {
    console.error(`${command.color}[${command.name}]\x1b[0m Failed to start`, error);
    stop(1, command.name);
  });

  child.once('exit', (code, signal) => {
    children.delete(command.name);

    if (!stopping) {
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? 1}`;
      console.log(`${command.color}[${command.name}]\x1b[0m Exited with ${reason}`);
      stop(code ?? 1, command.name);
    }

    finishWhenStopped();
  });
}

process.once('SIGINT', () => stop(130));
process.once('SIGTERM', () => stop(143));
process.once('SIGHUP', () => stop(129));

function stop(code, exitedName) {
  if (stopping) return;

  stopping = true;
  exitCode = code;

  for (const [name, child] of children) {
    if (name === exitedName || child.exitCode !== null || child.signalCode !== null) continue;
    terminate(child);
  }

  finishWhenStopped();
}

function terminate(child) {
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    return;
  }

  child.kill('SIGTERM');
}

function finishWhenStopped() {
  if (stopping && children.size === 0) {
    process.exitCode = exitCode;
  }
}
