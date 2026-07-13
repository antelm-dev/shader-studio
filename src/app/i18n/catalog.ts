import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { API_BASE_URL } from '../core/api-base-url';
import type { AppLocale } from './keys';

export type I18nCatalogMap = Readonly<Record<string, string>>;

export abstract class I18nCatalog {
  abstract load(locale: AppLocale): Promise<I18nCatalogMap>;
}

@Injectable()
export class HttpI18nCatalog extends I18nCatalog {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  override load(locale: AppLocale): Promise<I18nCatalogMap> {
    return firstValueFrom(
      this.http.get<{ catalog: I18nCatalogMap }>(`${this.baseUrl}/api/i18n/${locale}`),
    ).then((body) => body.catalog);
  }
}

@Injectable()
export class DesktopI18nCatalog extends I18nCatalog {
  override load(locale: AppLocale): Promise<I18nCatalogMap> {
    return window.electron.bridge.i18n.catalog(locale);
  }
}
