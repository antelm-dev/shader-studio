import {
  Module,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { ShaderLibrary } from '@shader-studio/backend/library';

import type { Auditor } from '../auth/audit';
import { consoleAuditor } from '../auth/audit';
import type { Auth } from '../auth/auth';
import { DesktopHandoffController } from '../auth/desktop-handoff';
import { ApiController } from './api.controller';
import { AUDITOR, AUTH_INSTANCE, SHADER_LIBRARY } from './api.constants';
import { AuthGuard } from './auth.guard';
import { RequestLogger } from './logger';

@Module({})
export class ApiModule implements NestModule {
  static forLibrary(
    library: ShaderLibrary,
    auth: Auth,
    auditor: Auditor = consoleAuditor,
  ): DynamicModule {
    return {
      module: ApiModule,
      controllers: [ApiController, DesktopHandoffController],
      providers: [
        { provide: SHADER_LIBRARY, useValue: library },
        { provide: AUTH_INSTANCE, useValue: auth },
        { provide: AUDITOR, useValue: auditor },
        RequestLogger,
        // Registered globally, so a route added later is protected unless it
        // opts out with @Public — the safe direction for a mistake to fail in.
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestLogger).forRoutes('{*path}');
  }
}
