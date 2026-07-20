import { registerLocaleData } from '@angular/common';
import localeFr from '@angular/common/locales/fr';
import {
  LOCALE_ID,
  type EnvironmentProviders,
  type Type,
  inject,
  makeEnvironmentProviders,
  provideAppInitializer,
} from '@angular/core';

import { Preferences } from '../prefs/preferences';
import { I18nCatalog } from './catalog';
import { I18n } from './i18n';

registerLocaleData(localeFr);

export function provideI18n(catalog: Type<I18nCatalog>): EnvironmentProviders {
  return makeEnvironmentProviders([
    catalog,
    { provide: I18nCatalog, useExisting: catalog },
    {
      provide: LOCALE_ID,
      useFactory: () => inject(Preferences).value().language,
    },
    provideAppInitializer(() => {
      const i18n = inject(I18n);
      return i18n.ensureLoaded(i18n.locale());
    }),
  ]);
}
