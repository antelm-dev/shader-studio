import { InjectionToken } from '@angular/core';

/**
 * Prefix for every API call.
 *
 * In the browser this is empty: requests are relative and therefore
 * same-origin. During SSR there is no origin to be relative to, so
 * `app.config.server.ts` overrides this with the absolute origin of the
 * incoming request — the Express process then answers its own call from the
 * `/api` router it already has mounted.
 */
export const API_BASE_URL = new InjectionToken<string>('API_BASE_URL', {
  providedIn: 'root',
  factory: () => '',
});
