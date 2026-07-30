import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { chromium } from 'playwright';

import { createLogger } from './lib/logger.js';
import { root } from './lib/paths.js';

const log = createLogger('smoke');
const webDir = resolve(root, 'apps/web');
const require = createRequire(resolve(webDir, 'package.json'));
const ngCli = require.resolve('@angular/cli/bin/ng.js');
const PORT = Number(process.env['SMOKE_PORT'] ?? 4321);
const BASE = `http://127.0.0.1:${PORT}`;
const READY = /Local:\s+http:\/\/(?:localhost|127\.0\.0\.1):/;

const ipc = spawnSync('pnpm', ['--filter', '@shader-studio/desktop', 'gen:ipc'], {
  cwd: root,
  encoding: 'utf8',
  shell: process.platform === 'win32',
});
if (ipc.status !== 0) {
  log.error('smoke requires gen:ipc — window.electron types come from @shader-studio/desktop-api');
  log.error(ipc.stderr || ipc.stdout);
  process.exit(ipc.status ?? 1);
}

const server = spawn(process.execPath, [ngCli, 'serve', `--port=${PORT}`, '--host=127.0.0.1'], {
  cwd: webDir,
  env: { ...process.env, FORCE_COLOR: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let output = '';
const onChunk = (chunk: Buffer) => {
  output += chunk.toString();
};
server.stdout?.on('data', onChunk);
server.stderr?.on('data', onChunk);

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
  await page
    .locator('app-inspector-shell.inspector')
    .waitFor({ state: 'visible', timeout: 30_000 });
  await delay(1_200);
  await page
    .locator('.lil-gui .lil-controller')
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 });

  await page.locator('button[aria-label="More actions"]').click();
  await page.getByRole('menuitem', { name: 'Show editor' }).click();
  await page.locator('app-editor-shell').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('.monaco-editor').waitFor({ state: 'visible', timeout: 30_000 });

  // Bounded Profiler path: open the bottom-panel tab, assert honest content, then leave and
  // confirm the panel is no longer active. Headless Chromium typically lacks
  // EXT_disjoint_timer_query_webgl2, so the unsupported/empty copy is the
  // supported-path stand-in; deterministic unit tests cover the timing path.
  await page.keyboard.press('Control+J');
  const bottomPanel = page.locator('app-bottom-panel');
  await bottomPanel.waitFor({ state: 'visible', timeout: 10_000 });
  await page.evaluate(`(() => {
    const tab = [...document.querySelectorAll('app-bottom-panel [role="tab"]')]
      .find((item) => /Profiler/i.test(item.textContent ?? ''));
    if (!(tab instanceof HTMLElement)) throw new Error('Profiler tab not found');
    tab.click();
  })()`);
  const profiler = bottomPanel.locator('app-profiler-panel');
  await profiler.waitFor({ state: 'visible', timeout: 15_000 });
  const profilerStatePattern =
    /GPU timing is unavailable|Collecting GPU samples|Waiting for the active preview|GPU timing was interrupted by the driver/i;
  const profilerText = await waitForMatch(() => profiler.innerText(), profilerStatePattern, 10_000);
  const observedProfilerState = profilerStatePattern.exec(profilerText)?.[0] ?? 'unknown';
  log.info(`Profiler state observed: ${observedProfilerState}`);

  // Force-path DOM click: the preview canvas can intercept Playwright hit-testing
  // even when the tab is scrolled into view inside the docked panel.
  await page.evaluate(`(() => {
    const tabs = document.querySelectorAll('app-bottom-panel [role="tab"]');
    const output = [...tabs].find((tab) => /Output/i.test(tab.textContent ?? ''));
    if (!(output instanceof HTMLElement)) throw new Error('Output tab not found');
    output.click();
  })()`);
  await waitForMatch(
    async () =>
      [
        await bottomPanel.getByRole('tab', { name: /Profiler/i }).getAttribute('aria-selected'),
        await bottomPanel.getByRole('tab', { name: /Output/i }).getAttribute('aria-selected'),
      ].join(','),
    /^false,true$/,
    5_000,
  );
  await bottomPanel.locator('app-output-panel').waitFor({ state: 'visible', timeout: 10_000 });
  // preserveContent keeps ProfilerPanel mounted; disable-on-leave is covered by
  // mounted unit tests via setProfilingEnabled(false). Smoke asserts the tab left.

  await browser.close();
  log.info('smoke ok — drawer, inspector controls, Monaco editor, and Profiler tab loaded');
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

function assertServeHealthy(): void {
  if (/Application bundle generation failed|ERROR in |✘ \[ERROR\]/i.test(output)) {
    throw new Error('ng serve reported a compile failure');
  }
}

async function waitForMatch(
  read: () => Promise<string>,
  pattern: RegExp,
  timeoutMs: number,
): Promise<string> {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    last = await read();
    if (pattern.test(last)) return last;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${pattern}: last text was ${JSON.stringify(last)}`);
}

function waitForReady(timeoutMs: number): Promise<void> {
  return new Promise<void>((resolveReady, reject) => {
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
