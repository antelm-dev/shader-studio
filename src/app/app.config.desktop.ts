import {
  type ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';
import { DesktopShaderApi } from './core/desktop-api';
import { ShaderApi } from './core/shader-api';

export const desktopConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(routes),
    DesktopShaderApi,
    { provide: ShaderApi, useExisting: DesktopShaderApi },
  ],
};
