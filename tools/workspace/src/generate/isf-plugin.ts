/**
 * Builds the installable ISF plugin, `fixtures/plugins/isf/isf.sgplugin.json`,
 * from its manifest and its Worker code. The web spec that runs the package
 * through the real `PluginHost` also checks this file is what these sources
 * build, so the two cannot drift.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createLogger } from '../lib/logger.js';
import { root } from '../lib/paths.js';

const log = createLogger('isf-plugin');
const dir = resolve(root, 'tools/workspace/fixtures/plugins/isf');

export function buildIsfPackage(): string {
  const manifest = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8')) as unknown;
  const code = readFileSync(resolve(dir, 'isf-plugin.js'), 'utf8').replace(/\r\n/g, '\n');
  return `${JSON.stringify({ manifest, code }, null, 2)}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const out = resolve(dir, 'isf.sgplugin.json');
  writeFileSync(out, buildIsfPackage());
  log.info(`Wrote ${out}`);
}
