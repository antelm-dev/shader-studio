/**
 * Every cookie-authenticated write to a Nest route is checked against the
 * trusted origins. Better Auth does that for its own endpoints only, so without
 * this guard a third-party page could act on the back of a signed-in visitor's
 * cookie.
 */

import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import { StorageError } from '@shadergrove/backend/library';

import type { Auth } from '../auth/auth';
import { AUTH_INSTANCE } from './api.constants';

/** Refuses a cookie-authenticated write that a page on another origin started. */
@Injectable()
export class TrustedOriginGuard implements CanActivate {
  constructor(@Inject(AUTH_INSTANCE) private readonly auth: Auth) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    // Reads change nothing, and a request without a cookie (the desktop's
    // bearer token) is not one a browser can be tricked into sending.
    if (request.method === 'GET' || request.method === 'HEAD' || !request.headers.cookie) {
      return true;
    }
    const trusted = (this.auth.options.trustedOrigins ?? []) as readonly string[];
    const origin = request.headers.origin;
    if (!origin || !trusted.includes(origin)) {
      throw new StorageError('forbidden', 'This request did not come from the application');
    }
    return true;
  }
}
