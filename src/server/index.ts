/**
 * The Express server. It does two jobs:
 *
 *  1. `/api/*` — the shader REST API, backed by the filesystem (`server/`).
 *  2. everything else — server-side rendering of the Angular app.
 *
 * The same process serves both, which is what lets the app render on the server
 * against its own API over a same-origin request (see `api-base-url.ts`).
 *
 * In development the Angular CLI imports `reqHandler` below and drives this
 * same app, so `ng serve` gets the real API rather than a mock.
 */

import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import { join } from 'node:path';

import { createApiRouter } from './api/router';
import { ShaderStorage } from './storage';

const browserDistFolder = join(import.meta.dirname, '../browser');

const allowedHosts = (process.env['NG_ALLOWED_HOSTS'] ?? 'localhost,127.0.0.1,[::1]')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);

const app = express();
const angularApp = new AngularNodeAppEngine({ allowedHosts });

const storage = new ShaderStorage();

const ready = storage.init().catch((error: unknown) => {
  console.error('[server] failed to initialise shader storage', error);
  throw error;
});

app.use('/api', (_req, _res, next) => {
  ready.then(() => next()).catch(next);
});
app.use('/api', createApiRouter(storage));

app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) => (response ? writeResponseToNodeResponse(response, res) : next()))
    .catch(next);
});

if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = Number(process.env['PORT'] ?? 4000);
  app.listen(port, (error?: Error) => {
    if (error) {
      throw error;
    }

    console.log(`Shader Studio listening on http://localhost:${port}`);
  });
}

export const reqHandler = createNodeRequestHandler(app);
