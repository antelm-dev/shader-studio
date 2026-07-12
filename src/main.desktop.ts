import { bootstrapApplication } from '@angular/platform-browser';

import { App } from './app/app';
import { desktopConfig } from './app/app.config.desktop';

bootstrapApplication(App, desktopConfig).catch((error: unknown) => console.error(error));
