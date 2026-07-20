import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { chromium } from 'playwright';

import { createLogger } from './_lib/logger.mjs';
import { root, script } from './_lib/paths.mjs';

const log = createLogger('smoke');
const require = createRequire(resolve(root, 'package.json'));
const ngCli = require.resolve('@angular/cli/bin/ng.js');
const PORT = Number(process.env.SMOKE_PORT ?? 4321);
const BASE = `http://127.0.0.1:${PORT}`;
const READY = /Local:\s+http:\/\/(?:localhost|127\.0\.0\.1):/;

const ipc = spawnSync(process.execPath, [script('gen/ipc.mjs')], {
  cwd: root,
  encoding: 'utf8',
});
if (ipc.status !== 0) {
  log.error('smoke requires gen:ipc — window.electron types come from apps/desktop/generated/');
  log.error(ipc.stderr || ipc.stdout);
  process.exit(ipc.status ?? 1);
}

const server = spawn(process.execPath, [ngCli, 'serve', `--port=${PORT}`, '--host=127.0.0.1'], {
  cwd: root,
  env: { ...process.env, FORCE_COLOR: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let output = '';
const onChunk = (chunk) => {
  output += chunk.toString();
};
server.stdout.on('data', onChunk);
server.stderr.on('data', onChunk);

let exiting = false;
const shutdown = async (code = 0) => {
  if (exiting) return;
  exiting = true;
  if (!server.killed) {
    server.kill('SIGTERM');
    await delay(500);
    if (!server.killed) server.kill('SIGKILL');
  }
  process.exit(code);
};

process.on('SIGINT', () => void shutdown(130));
process.on('SIGTERM', () => void shutdown(143));

try {
  await waitForReady(90_000);
  assertServeHealthy();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.locator('mat-sidenav.drawer').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('aside.inspector').waitFor({ state: 'visible', timeout: 30_000 });
  await delay(1_200);
  await page
    .locator('.lil-gui .lil-controller')
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 });

  await page.locator('button[aria-label="More actions"]').click();
  await page.getByRole('menuitem', { name: 'Show editor' }).click();
  await page.locator('app-editor-shell').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('.monaco-editor').waitFor({ state: 'visible', timeout: 30_000 });

  await browser.close();
  log.info('smoke ok — drawer, inspector controls, and Monaco editor loaded');
  await shutdown(0);
} catch (error) {
  log.error('smoke failed');
  log.error(error);
  if (output.trim()) {
    log.error('--- ng serve output ---');
    log.error(output.slice(-8_000));
  }
  await shutdown(1);
}

function assertServeHealthy() {
  if (/Application bundle generation failed|ERROR in |✘ \[ERROR\]/i.test(output)) {
    throw new Error('ng serve reported a compile failure');
  }
}

function waitForReady(timeoutMs) {
  return new Promise((resolveReady, reject) => {
    const started = Date.now();

    const check = () => {
      if (/Application bundle generation failed/i.test(output)) {
        reject(new Error('ng serve failed to compile the application'));
        return;
      }
      if (READY.test(output)) {
        resolveReady();
        return;
      }
      if (server.exitCode !== null) {
        reject(new Error(`ng serve exited early with code ${server.exitCode}`));
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Timed out waiting for ng serve on port ${PORT}`));
        return;
      }
      setTimeout(check, 250);
    };

    check();
  });
}
