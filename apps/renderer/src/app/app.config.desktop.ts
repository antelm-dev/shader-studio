import {
  type ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';
import { DesktopShaderApi } from './desktop/desktop-shader-api';
import { ShaderApi } from './api/shader-api';
import { DesktopI18nCatalog } from './i18n/catalog';
import { provideI18n } from './i18n/provide-i18n';

export const desktopConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(routes),
    DesktopShaderApi,
    { provide: ShaderApi, useExisting: DesktopShaderApi },
    provideI18n(DesktopI18nCatalog),
  ],
};
