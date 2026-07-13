import {
  type ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';
import { DesktopShaderApi } from './core/desktop-api';
import { ShaderApi } from './core/shader-api';
import { DesktopI18nCatalog, I18nCatalog } from './i18n/catalog';
import { I18n } from './i18n/i18n';

export const desktopConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(routes),
    DesktopShaderApi,
    { provide: ShaderApi, useExisting: DesktopShaderApi },
    DesktopI18nCatalog,
    { provide: I18nCatalog, useExisting: DesktopI18nCatalog },
    provideAppInitializer(() => {
      const i18n = inject(I18n);
      return i18n.ensureLoaded(i18n.locale());
    }),
  ],
};
