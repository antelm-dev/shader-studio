import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideClientHydration, withEventReplay } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';
import { HttpShaderApi, ShaderApi } from './core/shader-api';
import { HttpI18nCatalog, I18nCatalog } from './i18n/catalog';
import { I18n } from './i18n/i18n';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(routes),
    provideHttpClient(),
    HttpShaderApi,
    { provide: ShaderApi, useExisting: HttpShaderApi },
    HttpI18nCatalog,
    { provide: I18nCatalog, useExisting: HttpI18nCatalog },
    provideAppInitializer(() => {
      const i18n = inject(I18n);
      return i18n.ensureLoaded(i18n.locale());
    }),
    provideClientHydration(withEventReplay()),
  ],
};
