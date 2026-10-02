import { Module } from '@nestjs/common';

import { ModerationController } from './moderation.controller';

/** Only imported while Explore is on (see ApiModule). */
@Module({ controllers: [ModerationController] })
export class AdminModule {}
