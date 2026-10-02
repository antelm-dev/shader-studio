import { Global, Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { ShaderLibrary } from '@shadergrove/backend/library';

import type { Auditor } from '../auth/audit';
import type { Auth } from '../auth/auth';
import type { Explore } from '../publications/explore';
import { AUDITOR, AUTH_INSTANCE, EXPLORE, SHADER_LIBRARY } from './api.constants';
import { AuthGuard } from './auth.guard';

export interface CoreOptions {
  library: ShaderLibrary;
  auth: Auth;
  auditor: Auditor;
  explore: Explore;
}

/** What every feature module injects, provided once and globally. */
@Global()
@Module({})
export class CoreModule {
  static forRoot({ library, auth, auditor, explore }: CoreOptions): DynamicModule {
    const values = [
      { provide: SHADER_LIBRARY, useValue: library },
      { provide: AUTH_INSTANCE, useValue: auth },
      { provide: AUDITOR, useValue: auditor },
      { provide: EXPLORE, useValue: explore },
    ];
    return {
      module: CoreModule,
      providers: [
        ...values,
        // Registered globally, so a route added later is protected unless it
        // opts out with @Public — the safe direction for a mistake to fail in.
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
      exports: values.map((value) => value.provide),
    };
  }
}
