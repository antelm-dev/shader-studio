import { Module } from '@nestjs/common';

import { DesktopHandoffController } from './desktop-handoff';

/**
 * Better Auth serves its own `/auth/*` routes (mounted in bootstrap.ts, before
 * any body parser); this module holds the Nest routes beside them.
 */
@Module({ controllers: [DesktopHandoffController] })
export class AuthModule {}
