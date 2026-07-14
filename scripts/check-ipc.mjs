import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ipcDir = resolve(root, 'main/ipc');
const outFile = resolve(root, 'main/generated/ipc-bridge.ts');

const moduleNames = readdirSync(ipcDir)
  .filter((name) => name.endsWith('.ipc.ts'))
  .map((name) => {
    const source = readFileSync(resolve(ipcDir, name), 'utf8');
    const match = source.match(/defineIpcModule\(\s*'([^']+)'/);
    if (!match) {
      fail(`Could not find defineIpcModule name in main/ipc/${name}`);
    }
    return match[1];
  })
  .sort();

if (moduleNames.length === 0) fail('No IPC modules found under main/ipc');

const generated = spawnSync(process.execPath, [resolve(root, 'scripts/gen-ipc.mjs')], {
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

console.log(`ipc ok — generated bridge for ${moduleNames.join(', ')}`);

function fail(message) {
  console.error(message);
  process.exit(1);
}
