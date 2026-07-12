import { ApplicationConfig, REQUEST, mergeApplicationConfig } from '@angular/core';
import { provideServerRendering, withRoutes } from '@angular/ssr';

import { API_BASE_URL } from './core/api-base-url';
import { appConfig } from './app.config';
import { serverRoutes } from './app.routes.server';

/**
 * During SSR there is no origin for a relative URL to resolve against, so the
 * API base is made absolute from the incoming request. It points straight back
 * at this same Express process, which already serves `/api`: the renderer and
 * the API are one server, so the call never leaves the machine.
 */
const serverConfig: ApplicationConfig = {
  providers: [
    provideServerRendering(withRoutes(serverRoutes)),
    {
      provide: API_BASE_URL,
      useFactory: (request: Request | null) =>
        // There is no request when prerendering or under a unit test; localhost
        // is both the best guess and the only server that could answer.
        request ? new URL(request.url).origin : `http://localhost:${process.env['PORT'] ?? 4000}`,
      deps: [REQUEST],
    },
  ],
};

export const config = mergeApplicationConfig(appConfig, serverConfig);
