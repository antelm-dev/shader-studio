import {
  type ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { MatIconRegistry } from '@angular/material/icon';
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
    // Icons are ligatures in the bundled Material Symbols font, not legacy Material Icons.
    provideAppInitializer(() => {
      inject(MatIconRegistry).setDefaultFontSetClass(
        'material-symbols-outlined',
        'mat-ligature-font',
      );
    }),
  ],
};
