import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { createLogger } from '../_lib/logger.mjs';
import { root, script } from '../_lib/paths.mjs';

const log = createLogger('ipc');
const ipcDir = resolve(root, 'apps/desktop/main/src/ipc');
const outFile = resolve(root, 'apps/desktop/generated/ipc-bridge.ts');

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

const generated = spawnSync(process.execPath, [script('gen/ipc.mjs')], {
  cwd: root,
  encoding: 'utf8',
});
if (generated.status !== 0) {
  fail(`gen:ipc failed:\n${generated.stderr || generated.stdout}`);
}

if (!existsSync(outFile)) {
  fail(`gen:ipc did not write ${outFile}`);
}

const bridge = readFileSync(outFile, 'utf8');
const errors = [];

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

log.info(`ipc ok — generated bridge for ${moduleNames.join(', ')}`);

function fail(message) {
  log.error(message);
  process.exit(1);
}
