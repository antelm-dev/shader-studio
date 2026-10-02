import { Module } from '@nestjs/common';

import { ShadersController } from './shaders.controller';

@Module({ controllers: [ShadersController] })
export class ShadersModule {}
