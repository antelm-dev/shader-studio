import {
  Module,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import type { ShaderLibrary } from '@shader-studio/backend/library';

import { ApiController } from './api.controller';
import { SHADER_LIBRARY } from './api.constants';
import { RequestLogger } from './logger';

@Module({})
export class ApiModule implements NestModule {
  static forLibrary(library: ShaderLibrary): DynamicModule {
    return {
      module: ApiModule,
      controllers: [ApiController],
      providers: [{ provide: SHADER_LIBRARY, useValue: library }, RequestLogger],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestLogger).forRoutes('{*path}');
  }
}
