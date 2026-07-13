import { ApplicationConfig, REQUEST, mergeApplicationConfig } from '@angular/core';
import { provideServerRendering, withRoutes } from '@angular/ssr';

import { API_BASE_URL } from './core/api-base-url';
import { appConfig } from './app.config';
import { serverRoutes } from './app.routes.server';
import { ServerI18nCatalog } from './i18n/catalog.server';
import { provideI18n } from './i18n/provide-i18n';

const serverConfig: ApplicationConfig = {
  providers: [
    provideServerRendering(withRoutes(serverRoutes)),
    provideI18n(ServerI18nCatalog),
    {
      provide: API_BASE_URL,
      useFactory: (request: Request | null) =>
        request ? new URL(request.url).origin : `http://localhost:${process.env['PORT'] ?? 4200}`,
      deps: [REQUEST],
    },
  ],
};

export const config = mergeApplicationConfig(appConfig, serverConfig);
