import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import { StorageError } from '@shadergrove/backend/library';

import type { Principal } from '../auth/auth';
import { EXPLORE } from '../core/api.constants';
import { isAdmin, type Explore } from '../publications/explore';

/** Runs after the global `AuthGuard`, so a principal is already on the request. */
@Injectable()
export class ModeratorGuard implements CanActivate {
  constructor(@Inject(EXPLORE) private readonly explore: Explore) {}

  canActivate(context: ExecutionContext): boolean {
    const { principal } = context.switchToHttp().getRequest<Request & { principal?: Principal }>();
    if (!isAdmin(this.explore, principal)) {
      throw new StorageError('forbidden', 'Moderator access is required');
    }
    return true;
  }
}
