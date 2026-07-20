import { spawn, spawnSync } from 'node:child_process';

import { createLogger } from '../../../scripts/_lib/logger.mjs';

const commands = [
  {
    name: 'angular',
    entry: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    args: ['--filter', '@shader-studio/renderer', 'dev:desktop'],
    stdin: 'ignore',
  },
  {
    name: 'rollup',
    entry: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    args: ['exec', 'rollup', '-c', '--environment', 'NODE_ENV:development', '--watch'],
    stdin: 'inherit',
  },
];

const children = new Map();
let stopping = false;
let exitCode = 0;

for (const command of commands) {
  const log = createLogger(command.name);
  log.info(command.args.join(' '));

  const child = spawn(command.entry, command.args, {
    stdio: [command.stdin, 'inherit', 'inherit'],
    env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '1' },
    shell: process.platform === 'win32' && command.entry.endsWith('.cmd'),
  });

  children.set(command.name, child);

  child.once('error', (error) => {
    log.error('Failed to start', error);
    stop(1, command.name);
  });

  child.once('exit', (code, signal) => {
    children.delete(command.name);

    if (!stopping) {
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? 1}`;
      log.info(`Exited with ${reason}`);
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
