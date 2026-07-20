import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideClientHydration, withEventReplay } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';
import { HttpShaderApi, ShaderApi } from './api/shader-api';
import { HttpI18nCatalog } from './i18n/catalog';
import { provideI18n } from './i18n/provide-i18n';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(routes),
    provideHttpClient(),
    HttpShaderApi,
    { provide: ShaderApi, useExisting: HttpShaderApi },
    provideI18n(HttpI18nCatalog),
    provideClientHydration(withEventReplay()),
  ],
};
