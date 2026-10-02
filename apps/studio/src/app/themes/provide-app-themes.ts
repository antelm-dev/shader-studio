import { inject, provideAppInitializer, type EnvironmentProviders } from '@angular/core';

import { AppThemes } from './app-themes';

/**
 * Starts the theme service with the app, web and desktop alike — not when the
 * Plugins page first opens — so a chosen theme comes back on every start.
 */
export function provideAppThemes(): EnvironmentProviders {
  return provideAppInitializer(() => inject(AppThemes).start());
}
