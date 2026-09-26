/// <reference types="@angular/localize" />

import { isDevMode } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

bootstrapApplication(App, appConfig).catch((err) => console.error(err));

// ponytail: dev-only escape probe for the plugin sandbox prototype; remove once hostile tests run in CI.
if (isDevMode()) {
  Object.assign(globalThis, {
    pluginSandboxProbe: () =>
      import('./app/plugins/sandbox-probe').then((m) => m.runSandboxProbe()),
  });
}
