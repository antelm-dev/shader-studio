import { spawn, spawnSync } from 'node:child_process';
import { get } from 'node:http';

import { createLogger } from './_lib/logger.mjs';

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const devServerUrl = 'http://localhost:4201';
const commands = {
  angular: {
    name: 'angular',
    entry: pnpm,
    args: ['--filter', '@shader-studio/web', 'dev:desktop'],
    stdin: 'ignore',
  },
  rollup: {
    name: 'rollup',
    entry: pnpm,
    args: ['exec', 'rollup', '-c', '--environment', 'NODE_ENV:development', '--watch'],
    stdin: 'inherit',
  },
};

const children = new Map();
let stopping = false;
let exitCode = 0;

start(commands.angular);
void startElectronAfterDevServerIsReady();

async function startElectronAfterDevServerIsReady() {
  const log = createLogger('angular');
  log.info(`Waiting for ${devServerUrl}`);

  try {
    await waitForServer(devServerUrl);
  } catch (error) {
    if (!stopping) {
      log.error('Development server did not become ready', error);
      stop(1);
    }
    return;
  }

  if (!stopping) start(commands.rollup);
}

function start(command) {
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

function waitForServer(url, timeoutMs = 120_000, retryMs = 250) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const check = () => {
      if (stopping) {
        reject(new Error('Development launch was stopped'));
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for ${url}`));
        return;
      }

      const request = get(url, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 400) {
          resolve();
        } else {
          setTimeout(check, retryMs);
        }
      });
      request.setTimeout(1_000, () => request.destroy());
      request.once('error', () => setTimeout(check, retryMs));
    };

    check();
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
