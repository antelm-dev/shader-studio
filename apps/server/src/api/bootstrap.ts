import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter, type NestExpressApplication } from '@nestjs/platform-express';
import express, { type Application, type NextFunction, type Request, type Response } from 'express';

import type { ShaderLibrary } from '@shader-studio/backend/library';

import { ApiExceptionFilter } from './api-exception.filter';
import { BODY_LIMIT, TEXTURE_BODY_LIMIT, THUMBNAIL_BODY_LIMIT } from './api.constants';
import { ApiModule } from './api.module';
import { logLevels } from './logger';
import { setupSwagger } from './swagger';

export interface NestApi {
  handler: Application;
  app: NestExpressApplication;
}

export async function createNestApi(library: ShaderLibrary): Promise<NestApi> {
  const logger = new Logger('api');
  const handler = express();

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
    ApiModule.forLibrary(library),
    new ExpressAdapter(handler),
    { bodyParser: false, logger: logLevels() },
  );
  app.useGlobalFilters(new ApiExceptionFilter());
  setupSwagger(app);
  await app.init();
  logger.log('shader API ready — docs on /api/docs');

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
    logger.error(
      'unhandled body parser error',
      error instanceof Error ? error.stack : String(error),
    );
    response.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  });

  return { handler, app };
}
