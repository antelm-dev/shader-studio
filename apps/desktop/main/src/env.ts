import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(fileURLToPath(import.meta.url));
declare const __ELECTRON_PRODUCTION__: boolean;

export const env = Object.freeze({
  production: __ELECTRON_PRODUCTION__,
  scheme: 'shader-studio',
  devServerUrl: 'http://localhost:4201',
  paths: {
    preload: join(rootDir, 'preload.cjs'),
    clientDir: join(rootDir, '../dist-renderer'),
  },
  urls: { renderer: 'shader-studio://bundle/' },
});
