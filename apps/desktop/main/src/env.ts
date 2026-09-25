import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(fileURLToPath(import.meta.url));
declare const __ELECTRON_PRODUCTION__: boolean;
/** The account server, embedded at build time; empty disables accounts. */
declare const __SHADER_STUDIO_ACCOUNT_URL__: string;

export const env = Object.freeze({
  production: __ELECTRON_PRODUCTION__,
  scheme: 'shader-studio',
  accountUrl: __SHADER_STUDIO_ACCOUNT_URL__,
  devServerUrl: 'http://localhost:4201',
  paths: {
    preload: join(rootDir, 'preload.cjs'),
    clientDir: join(rootDir, '../dist-web'),
  },
  urls: { web: 'shader-studio://bundle/' },
});
