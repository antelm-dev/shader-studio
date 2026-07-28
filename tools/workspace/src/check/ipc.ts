import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

import { createLogger } from '../lib/logger.js';
import { root } from '../lib/paths.js';

const log = createLogger('ipc');
const desktopRoot = resolve(root, 'apps/desktop');
const ipcDir = resolve(desktopRoot, 'main/src/ipc');
const outFile = resolve(root, 'libs/desktop-api/src/ipc-bridge.ts');

const moduleNames = readdirSync(ipcDir)
  .filter((name) => name.endsWith('.ipc.ts'))
  .map((name) => {
    const source = readFileSync(resolve(ipcDir, name), 'utf8');
    const match = source.match(/defineIpcModule\(\s*'([^']+)'/);
    if (!match) {
      fail(`Could not find defineIpcModule name in apps/desktop/main/src/ipc/${name}`);
    }
    return match[1];
  })
  .sort();

if (moduleNames.length === 0) fail('No IPC modules found under apps/desktop/main/src/ipc');

/**
 * Invoke the generator script directly. Going through `pnpm gen:ipc` / Nx can
 * serve a cached terminal replay without rewriting the bridge, which would make
 * the second-run stability assertion tautological — especially across worktrees.
 */
function runGenIpc(): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ['scripts/gen-ipc.mjs'], {
    cwd: desktopRoot,
    encoding: 'utf8',
  });
}

const generated = runGenIpc();
if (generated.status !== 0) {
  fail(`gen:ipc failed:\n${generated.stderr || generated.stdout}`);
}

if (!existsSync(outFile)) {
  fail(`gen:ipc did not write ${outFile}`);
}

const bridge = readFileSync(outFile, 'utf8');
const errors: string[] = [];

for (const name of moduleNames) {
  if (!new RegExp(`\\b${name}\\s*:`).test(bridge)) {
    errors.push(`Bridge is missing module "${name}"`);
  }
}

if (!bridge.includes('export const bridge')) {
  errors.push('Bridge is missing `export const bridge`');
}

if (errors.length > 0) {
  fail(
    `IPC codegen check failed (${errors.length}):\n${errors.map((line) => `  - ${line}`).join('\n')}`,
  );
}

const second = runGenIpc();
if (second.status !== 0) {
  fail(`Second gen:ipc failed:\n${second.stderr || second.stdout}`);
}

const bridgeAfterSecondRun = readFileSync(outFile, 'utf8');
if (bridgeAfterSecondRun !== bridge) {
  fail('Second gen:ipc run changed ipc-bridge.ts — generation is not stable');
}

log.info(`ipc ok — generated bridge for ${moduleNames.join(', ')}`);

function fail(message: string): never {
  log.error(message);
  process.exit(1);
}
