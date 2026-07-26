import { NestFactory } from '@nestjs/core';
import { ExpressAdapter, type NestExpressApplication } from '@nestjs/platform-express';
import express, { type Application } from 'express';

import type { ShaderLibrary } from '@shader-studio/backend/library';

import { ApiExceptionFilter } from './api-exception.filter';
import { BODY_LIMIT, TEXTURE_BODY_LIMIT, THUMBNAIL_BODY_LIMIT } from './api.constants';
import { ApiModule } from './api.module';

export interface NestApi {
  handler: Application;
  app: NestExpressApplication;
}

export async function createNestApi(library: ShaderLibrary): Promise<NestApi> {
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
    { bodyParser: false },
  );
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.init();

  return { handler, app };
}
