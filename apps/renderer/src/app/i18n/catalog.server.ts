import { Injectable } from '@angular/core';

import { loadI18nCatalog } from '@shader-studio/backend/i18n';
import { I18nCatalog, type I18nCatalogMap } from './catalog';
import type { AppLocale } from './keys';

@Injectable()
export class ServerI18nCatalog extends I18nCatalog {
  override load(locale: AppLocale): Promise<I18nCatalogMap> {
    return loadI18nCatalog(locale);
  }
}
