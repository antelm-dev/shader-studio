import { NestFactory } from '@nestjs/core';
import { ExpressAdapter, type NestExpressApplication } from '@nestjs/platform-express';
import { toNodeHandler } from 'better-auth/node';
import express, { type Application, type NextFunction, type Request, type Response } from 'express';

import type { ShaderLibrary } from '@shader-studio/backend/library';

import type { Auth } from '../auth/auth';
import { ApiExceptionFilter } from './api-exception.filter';
import { BODY_LIMIT, TEXTURE_BODY_LIMIT, THUMBNAIL_BODY_LIMIT } from './api.constants';
import { ApiModule } from './api.module';

export interface NestApi {
  handler: Application;
  app: NestExpressApplication;
}

export async function createNestApi(library: ShaderLibrary, auth: Auth): Promise<NestApi> {
  const handler = express();

  // Mounted before every body parser: Better Auth reads and verifies the
  // request body itself, and a parser that already drained the stream leaves it
  // nothing to read. `all` rather than `use` so Express keeps the whole
  // `/auth/...` path in `req.url` for Better Auth to route on.
  const authHandler = toNodeHandler(auth);
  handler.all('/auth/*splat', (request, response) => {
    // Account and session responses describe *this* caller. A shared cache that
    // kept one would hand someone else's identity to the next visitor.
    response.setHeader('Cache-Control', 'no-store');
    // `req.url` is missing the `/api` mount prefix here, but the Node adapter
    // rebuilds the public path from `req.baseUrl` itself — so it must be left
    // alone. Rewriting it to `originalUrl` double-counts the prefix and every
    // route 404s.
    void authHandler(request, response);
  });

  handler.use(express.json({ limit: BODY_LIMIT }));
  handler.use(
    '/shaders/:id/textures/:channel',
    express.raw({ type: 'image/*', limit: TEXTURE_BODY_LIMIT }),
  );
  handler.use(
    '/shaders/:id/thumbnail',
    express.raw({ type: 'image/*', limit: THUMBNAIL_BODY_LIMIT }),
  );

  const app = await NestFactory.create<NestExpressApplication>(
    ApiModule.forLibrary(library, auth),
    new ExpressAdapter(handler),
    { bodyParser: false },
  );
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.init();

  // Body-parser errors happen before a Nest route is entered, so they cannot
  // reach the Nest exception filter. Keep their public envelope identical.
  handler.use((error: unknown, _request: Request, response: Response, next: NextFunction): void => {
    if (response.headersSent) {
      next(error);
      return;
    }
    if (error instanceof SyntaxError && 'body' in error) {
      response
        .status(400)
        .json({ error: { code: 'invalid', message: 'Request body is not valid JSON' } });
      return;
    }
    console.error('[api] unhandled body parser error', error);
    response.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  });

  return { handler, app };
}
