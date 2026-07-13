import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const I18N_LOCALES = ['en', 'fr'] as const;
export type I18nLocale = (typeof I18N_LOCALES)[number];

export type I18nCatalogData = Readonly<Record<string, string>>;

function isLocale(value: string): value is I18nLocale {
  return (I18N_LOCALES as readonly string[]).includes(value);
}

/**
 * Where the JSON catalogs live on disk.
 *
 * Prefer an explicit override (Electron's `resources/i18n` in production).
 * Otherwise walk from this module toward the repo root — works for `ng serve`
 * (source) and `node dist/.../server.mjs` (built next to a copied `i18n/`).
 */
export async function resolveI18nDir(override?: string): Promise<string> {
  if (override) return resolve(override);

  const candidates = [
    resolve('i18n'),
    resolve(fileURLToPath(new URL('../../../i18n', import.meta.url))),
    resolve(fileURLToPath(new URL('../../i18n', import.meta.url))),
    resolve(fileURLToPath(new URL('../i18n', import.meta.url))),
  ];

  for (const candidate of candidates) {
    try {
      await access(join(candidate, 'en.json'));
      return candidate;
    } catch {
      /* try next */
    }
  }

  throw new Error('Could not find the i18n catalogs on disk');
}

export async function loadI18nCatalog(locale: string, i18nDir?: string): Promise<I18nCatalogData> {
  if (!isLocale(locale)) {
    throw new Error(`Unsupported locale "${locale}"`);
  }
  const dir = await resolveI18nDir(i18nDir);
  const raw = await readFile(join(dir, `${locale}.json`), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid i18n catalog for "${locale}"`);
  }
  return parsed as I18nCatalogData;
}
