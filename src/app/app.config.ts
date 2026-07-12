import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideClientHydration, withEventReplay } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(routes),
    // HttpClient defaults to the fetch backend in v22, which is what lets it
    // run during SSR, where there is no XHR.
    provideHttpClient(),
    // Replays clicks that landed before the app finished booting.
    provideClientHydration(withEventReplay()),
    // No `provideAnimationsAsync()`: @angular/animations is deprecated as of
    // v22 and Material 22 animates with native CSS instead.
  ],
};
