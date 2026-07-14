import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keysSource = readFileSync(resolve(root, 'src/app/i18n/keys.ts'), 'utf8');
const locales = ['en', 'fr'];

const keysMatch = keysSource.match(/export const TRANSLATION_KEYS = \[([\s\S]*?)\] as const/);
if (!keysMatch) {
  fail('Could not parse TRANSLATION_KEYS from src/app/i18n/keys.ts');
}

const keys = [...keysMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
if (keys.length === 0) fail('TRANSLATION_KEYS is empty');

const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
if (duplicates.length > 0) {
  fail(`Duplicate TranslationKey entries:\n${unique(duplicates).map(bullet).join('\n')}`);
}

const catalogs = Object.fromEntries(
  locales.map((locale) => {
    const path = resolve(root, `i18n/${locale}.json`);
    return [locale, JSON.parse(readFileSync(path, 'utf8'))];
  }),
);

const errors = [];

for (const locale of locales) {
  const catalog = catalogs[locale];
  const catalogKeys = Object.keys(catalog);

  for (const key of keys) {
    if (!(key in catalog)) {
      errors.push(`Missing in i18n/${locale}.json: ${key}`);
      continue;
    }
    if (typeof catalog[key] !== 'string' || catalog[key].trim() === '') {
      errors.push(`Empty value in i18n/${locale}.json: ${key}`);
    }
  }

  for (const key of catalogKeys) {
    if (!keys.includes(key)) {
      errors.push(`Extra key in i18n/${locale}.json (not in TRANSLATION_KEYS): ${key}`);
    }
  }
}

const placeholderNames = (value) =>
  [...value.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)].map((match) => match[1]).sort();

for (const key of keys) {
  const expected = placeholderNames(catalogs.en[key] ?? '');
  for (const locale of locales) {
    if (!(key in catalogs[locale])) continue;
    const actual = placeholderNames(catalogs[locale][key]);
    if (actual.join(',') !== expected.join(',')) {
      errors.push(
        `Placeholder mismatch for ${key} in ${locale}: expected {${expected.join(', ')}} got {${actual.join(', ')}}`,
      );
    }
  }
}

if (errors.length > 0) {
  fail(`i18n check failed (${errors.length}):\n${errors.map(bullet).join('\n')}`);
}

console.log(`i18n ok — ${keys.length} keys × ${locales.length} locales`);

function bullet(line) {
  return `  - ${line}`;
}

function unique(values) {
  return [...new Set(values)];
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
