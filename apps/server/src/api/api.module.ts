import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { ShaderLibrary } from '@shader-studio/backend/library';

import type { Auditor } from '../auth/audit';
import { consoleAuditor } from '../auth/audit';
import type { Auth } from '../auth/auth';
import { ApiController } from './api.controller';
import { AUDITOR, AUTH_INSTANCE, SHADER_LIBRARY } from './api.constants';
import { AuthGuard } from './auth.guard';

@Module({})
export class ApiModule {
  static forLibrary(library: ShaderLibrary, auth: Auth, auditor: Auditor = consoleAuditor) {
    return {
      module: ApiModule,
      controllers: [ApiController],
      providers: [
        { provide: SHADER_LIBRARY, useValue: library },
        { provide: AUTH_INSTANCE, useValue: auth },
        { provide: AUDITOR, useValue: auditor },
        // Registered globally, so a route added later is protected unless it
        // opts out with @Public — the safe direction for a mistake to fail in.
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}
