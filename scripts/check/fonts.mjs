import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createLogger } from '../_lib/logger.mjs';
import { root } from '../_lib/paths.mjs';
import { FONT_OVERLAY, SYSTEM_FONT_ENTRY } from '../gen/font-overlay.mjs';

const log = createLogger('fonts');
const source = readFileSync(resolve(root, 'src/app/editor/font-catalogue.ts'), 'utf8');

const entryPattern =
  /\{\s*family:\s*(SYSTEM_FONT|'[^']*'|"[^"]*")\s*,\s*weights:\s*\[([^\]]*)\]\s*,\s*ligatures:\s*(true|false)\s*,\s*note:\s*('(?:\\'|[^'])*'|"(?:\\"|[^"])*")\s*,?\s*\}/gs;

const catalogue = [...source.matchAll(entryPattern)].map((match) => {
  const familyRaw = match[1];
  const family = familyRaw === 'SYSTEM_FONT' ? SYSTEM_FONT_ENTRY.family : familyRaw.slice(1, -1);
  const weights = match[2]
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map(Number);
  const ligatures = match[3] === 'true';
  return { family, weights, ligatures, note: unquote(match[4]) };
});

if (catalogue.length === 0) {
  fail('Could not parse FONT_CATALOGUE entries from src/app/editor/font-catalogue.ts');
}

const expected = [SYSTEM_FONT_ENTRY, ...FONT_OVERLAY];
const errors = [];

if (catalogue.length !== expected.length) {
  errors.push(
    `Entry count mismatch: catalogue has ${catalogue.length}, overlay expects ${expected.length}`,
  );
}

for (let index = 0; index < expected.length; index++) {
  const want = expected[index];
  const got = catalogue[index];
  if (!got) {
    errors.push(`Missing catalogue entry at index ${index}: ${want.family}`);
    continue;
  }
  if (got.family !== want.family) {
    errors.push(`Family at index ${index}: expected ${want.family}, got ${got.family}`);
  }
  if (got.ligatures !== want.ligatures) {
    errors.push(`Ligatures for ${want.family}: expected ${want.ligatures}, got ${got.ligatures}`);
  }
  if (got.note !== want.note) {
    errors.push(
      `Note for ${want.family}: expected ${JSON.stringify(want.note)}, got ${JSON.stringify(got.note)}`,
    );
  }
  if (!Array.isArray(got.weights) || got.weights.length === 0 || got.weights.some(Number.isNaN)) {
    errors.push(`Weights for ${want.family} are missing or invalid`);
  }
}

const unexpected = catalogue.slice(expected.length).map((entry) => entry.family);
if (unexpected.length > 0) {
  errors.push(`Extra catalogue entries: ${unexpected.join(', ')}`);
}

if (errors.length > 0) {
  fail(
    `Font catalogue check failed (${errors.length}):\n${errors.map((line) => `  - ${line}`).join('\n')}`,
  );
}

log.info(
  `fonts ok — ${catalogue.length} entries match scripts/gen/font-overlay.mjs (offline drift check)`,
);

function unquote(raw) {
  const quote = raw[0];
  const inner = raw.slice(1, -1);
  if (quote === '"') return JSON.parse(raw);
  return inner.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

function fail(message) {
  log.error(message);
  process.exit(1);
}
