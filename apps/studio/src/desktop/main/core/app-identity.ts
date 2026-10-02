import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Set before any account, library, or Chromium session reads its data path. */
export function configureAppIdentity(
  app: Pick<Electron.App, 'getPath' | 'setPath' | 'setName'>,
  production: boolean,
): void {
  // Keep the original directories and browser origin across the rebrand. Moving
  // either would hide existing libraries, account credentials, and preferences.
  const userData = join(app.getPath('appData'), production ? 'Shader Studio' : 'shader-studio');
  mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
  app.setPath('sessionData', userData);
  app.setName('Shadergrove');
}
