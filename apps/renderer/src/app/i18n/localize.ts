import { clearTranslations, loadTranslations, ɵ$localize as $localize } from '@angular/localize';

import type { I18nCatalogMap } from './catalog';
import type { AppLocale } from './keys';

export function toLocalizeTarget(template: string): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => `{$${name}}`);
}

export function catalogToLocalizeTranslations(catalog: I18nCatalogMap): Record<string, string> {
  const translations: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(catalog)) {
    translations[key] = toLocalizeTarget(value);
  }
  return translations;
}

export function applyLocalizeCatalog(locale: AppLocale, catalog: I18nCatalogMap): void {
  clearTranslations();
  loadTranslations(catalogToLocalizeTranslations(catalog));
  $localize.locale = locale;
}
