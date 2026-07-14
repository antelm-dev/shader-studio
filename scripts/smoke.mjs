import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT ?? 4321);
const BASE = `http://127.0.0.1:${PORT}`;
const READY = /Local:\s+http:\/\/(?:localhost|127\.0\.0\.1):/;

const server = spawn(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'ng', 'serve', `--port=${PORT}`, '--host=127.0.0.1'],
  {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  },
);

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
  console.log('smoke ok — drawer, inspector controls, and Monaco editor loaded');
  await shutdown(0);
} catch (error) {
  console.error('smoke failed');
  console.error(error);
  if (output.trim()) {
    console.error('\n--- ng serve output ---\n');
    console.error(output.slice(-8_000));
  }
  await shutdown(1);
}

function waitForReady(timeoutMs) {
  return new Promise((resolveReady, reject) => {
    const started = Date.now();

    const check = () => {
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
