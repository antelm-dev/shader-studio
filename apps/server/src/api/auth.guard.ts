/**
 * Turns the session cookie on a request into a principal, or refuses the
 * request. Every shader, preset, asset, import and export route goes through
 * here; translations and the Better Auth endpoints themselves do not (the
 * latter never reach Nest at all — see `bootstrap.ts`).
 *
 * The guard only establishes *who* is calling. What they may touch is decided
 * one layer down, in SQL, by the ownership scope — so a bug here cannot widen
 * access beyond the account the cookie names.
 */

import {
  Inject,
  Injectable,
  SetMetadata,
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { fromNodeHeaders } from 'better-auth/node';

import { StorageError } from '@shader-studio/backend/library';

import { resolvePrincipal, type Auth, type Principal } from '../auth/auth';
import { AUTH_INSTANCE } from './api.constants';

/** Marks a route anonymous visitors may call. */
export const PUBLIC_ROUTE = 'auth:public';
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);

/**
 * Marks a route that only needs *a* session, not a verified address — the
 * read-only side of the library, so someone who has signed up but not yet
 * clicked the link still sees their shaders instead of an empty app.
 */
export const ALLOW_UNVERIFIED = 'auth:allow-unverified';
export const AllowUnverified = () => SetMetadata(ALLOW_UNVERIFIED, true);

/** Thrown as a `StorageError` so it shares the API's one error envelope. */
function unauthorized(message: string): never {
  throw new StorageError('unauthorized', message);
}

interface AuthenticatedRequest extends Request {
  principal?: Principal;
}

@Injectable()
export class AuthGuard implements CanActivate {
  // Both tokens are explicit: the test runner transpiles with esbuild, which
  // emits no decorator metadata, so type-only injection would resolve to
  // `undefined` at runtime and only in the tests.
  constructor(
    @Inject(AUTH_INSTANCE) private readonly auth: Auth,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const controller = context.getClass();
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [handler, controller])) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = await resolvePrincipal(this.auth, fromNodeHeaders(request.headers));
    // Missing, expired and revoked sessions are all simply "no session": Better
    // Auth resolves against the database on every request, so a revoked row
    // stops authenticating immediately.
    if (!principal) unauthorized('Sign in to use your shader library');

    const readOnly = this.reflector.getAllAndOverride<boolean>(ALLOW_UNVERIFIED, [
      handler,
      controller,
    ]);
    if (!principal.emailVerified && !readOnly) {
      unauthorized('Confirm your email address before changing your library');
    }

    request.principal = principal;
    return true;
  }
}

/** `@CurrentUser() principal: Principal` in a controller method. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // Unreachable through the guard; a throw beats an `undefined` that would
    // otherwise become an ownership scope of "undefined".
    if (!request.principal) unauthorized('No authenticated session on this request');
    return request.principal;
  },
);
