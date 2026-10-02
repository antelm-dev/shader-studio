import { Module } from '@nestjs/common';

import { HealthController, I18nController } from './system.controller';

@Module({ controllers: [HealthController, I18nController] })
export class SystemModule {}
