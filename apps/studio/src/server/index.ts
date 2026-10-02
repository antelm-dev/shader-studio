/**
 * The Express server. It does two jobs:
 *
 *  1. `/api/*` — the NestJS REST API and accounts, backed by PostgreSQL or SQLite.
 *  2. everything else — server-side rendering of the Angular app.
 *
 * The same process serves both, which is what lets the app render on the server
 * against its own API over a same-origin request (see `api-base-url.ts`).
 *
 * In development the Angular CLI imports `reqHandler` below and drives this
 * same app, so `ng serve` gets the real API rather than a mock.
 *
 * The API lives beside this host in src/server/api; this file only composes.
 * Its dependencies are declared by studio. The Node-only packages (Nest,
 * drizzle-orm, nodemailer…) remain excluded from Vite prebundling in angular.json
 * so the SSR build handles their Node imports. When changing server dependencies,
 * verify development SSR, the production bundle and Docker runtime separately.
 */

import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import { Logger } from '@nestjs/common';
import {
  createAuth,
  createNestApi,
  readAuthConfig,
  readExploreConfig,
  securityHeaders,
} from './api/index';
import express, { type Application } from 'express';
import { join } from 'node:path';

import { createLibrary } from './create-library';

const browserDistFolder = join(import.meta.dirname, '../browser');

const allowedHosts = (process.env['NG_ALLOWED_HOSTS'] ?? 'localhost,127.0.0.1,[::1]')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);

const app = express();
const angularApp = new AngularNodeAppEngine({ allowedHosts });
const logger = new Logger('server');

// First, so they are on every response — including the error paths below, which
// are exactly the ones a later middleware would forget.
app.use(securityHeaders({ production: process.env['NODE_ENV'] === 'production' }));

// Storage is initialised lazily, on the first /api request. Doing it here rather
// than at module load keeps it out of Angular's build-time route extraction
// (which imports this module but never calls /api), and lets a transient
// database outage at startup recover on a later request instead of wedging.
let routerPromise: Promise<Application> | null = null;
function ensureRouter(): Promise<Application> {
  routerPromise ??= createLibrary()
    .then(async ({ library, authDatabase, publications }) => {
      const auth = createAuth(authDatabase, readAuthConfig());
      const explore = readExploreConfig();
      return (
        await createNestApi(library, auth, undefined, {
          adminUserIds: explore.adminUserIds,
          ...(explore.enabled ? { publications } : {}),
        })
      ).handler;
    })
    .catch((error: unknown) => {
      logger.error(
        'failed to initialise shader storage',
        error instanceof Error ? error.stack : String(error),
      );
      routerPromise = null; // let the next request retry
      throw error;
    });
  return routerPromise;
}

app.use('/api', (req, res, next) => {
  ensureRouter()
    .then((router) => router(req, res, next))
    .catch(() => {
      // Initialization failures are logged in ensureRouter. Return no database
      // details, and let the next readiness probe retry initialization.
      res.setHeader('Cache-Control', 'no-store');
      res.status(503).json({ error: { code: 'internal', message: 'Service unavailable' } });
    });
});

app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

// The Explore and moderation pages render publications into the HTML itself,
// and a publication can be hidden at any moment: a cached page would keep
// showing it, exactly as a cached API response would.
app.use(['/explore', '/admin'], (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) => (response ? writeResponseToNodeResponse(response, res) : next()))
    .catch(next);
});

if (isMainModule(import.meta.url) || process.env['pm_id']) {
  // Fail here rather than on the first sign-in attempt: a production server
  // missing its auth secret should never reach the point of accepting traffic.
  // This runs only when the module is actually serving, so Angular's build-time
  // route extraction — which imports this file with no environment — is unaffected.
  readAuthConfig();

  const port = Number(process.env['PORT'] ?? 4000);
  app.listen(port, (error?: Error) => {
    if (error) {
      throw error;
    }

    logger.log(`Shadergrove listening on http://localhost:${port}`);
  });
}

export const reqHandler = createNodeRequestHandler(app);
