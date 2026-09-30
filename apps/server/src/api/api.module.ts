import {
  Module,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { ShaderLibrary } from '@shadergrove/backend/library';

import type { Auditor } from '../auth/audit';
import { consoleAuditor } from '../auth/audit';
import type { Auth } from '../auth/auth';
import { DesktopHandoffController } from '../auth/desktop-handoff';
import {
  CapabilitiesController,
  EXPLORE_OFF,
  ModerationController,
  PublicationsController,
  type Explore,
} from '../publication/publications.controller';
import { ApiController } from './api.controller';
import { AUDITOR, AUTH_INSTANCE, EXPLORE, SHADER_LIBRARY } from './api.constants';
import { AuthGuard } from './auth.guard';
import { RequestLogger } from './logger';

@Module({})
export class ApiModule implements NestModule {
  static forLibrary(
    library: ShaderLibrary,
    auth: Auth,
    auditor: Auditor = consoleAuditor,
    explore: Explore = EXPLORE_OFF,
  ): DynamicModule {
    return {
      module: ApiModule,
      controllers: [
        ApiController,
        DesktopHandoffController,
        CapabilitiesController,
        // Not registered at all while the feature is off: the routes do not
        // exist, rather than existing and refusing.
        ...(explore.publications ? [PublicationsController, ModerationController] : []),
      ],
      providers: [
        { provide: EXPLORE, useValue: explore },
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
