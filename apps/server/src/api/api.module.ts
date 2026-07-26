import { Module } from '@nestjs/common';
import type { ShaderLibrary } from '@shader-studio/backend/library';

import { ApiController } from './api.controller';
import { SHADER_LIBRARY } from './api.constants';

@Module({})
export class ApiModule {
  static forLibrary(library: ShaderLibrary) {
    return {
      module: ApiModule,
      controllers: [ApiController],
      providers: [{ provide: SHADER_LIBRARY, useValue: library }],
    };
  }
}
