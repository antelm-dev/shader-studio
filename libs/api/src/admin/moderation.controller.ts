/**
 * Moderation of public Explore: every publication and report, visible or not,
 * and the publishers' restrictions. Granted by the server's own list of account
 * ids and nothing else — not a claim in the request, not anything the client
 * was told (see `ModeratorGuard`). Every write is recorded in the audit.
 */

import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Logger,
  Param,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { THUMBNAIL_ASSET_KEY } from '@shadergrove/backend/persistence';
import type { PublicationLibrary } from '@shadergrove/backend/publication';

import type { Principal } from '../auth/auth';
import { EXPLORE } from '../core/api.constants';
import { CurrentUser } from '../core/auth.guard';
import { ApiErrors } from '../core/swagger';
import { TrustedOriginGuard } from '../core/trusted-origin.guard';
import { sendImage, textureKey } from '../publications/assets';
import type { Explore } from '../publications/explore';
import { ModeratorGuard } from './moderator.guard';

type JsonBody = Record<string, unknown> | undefined;
type QueryParams = Record<string, unknown>;

@ApiTags('moderation')
@Controller('admin')
@UseGuards(TrustedOriginGuard, ModeratorGuard)
export class ModerationController {
  private readonly logger = new Logger('moderation');

  constructor(@Inject(EXPLORE) private readonly explore: Explore) {}

  private get publications(): PublicationLibrary {
    return this.explore.publications!;
  }

  @ApiOperation({
    summary: 'List every publication',
    description: '`state` is `all` (default), `visible` or `hidden`; paging as the public list.',
  })
  @ApiErrors(400, 403)
  @Get('publications')
  @Header('Cache-Control', 'no-store')
  list(@Query() query: QueryParams): Promise<unknown> {
    return this.publications.adminList(query);
  }

  @ApiOperation({ summary: 'Inspect a publication, visible or not' })
  @ApiErrors(403, 404)
  @Get('publications/:id')
  @Header('Cache-Control', 'no-store')
  async read(@Param('id') id: string): Promise<unknown> {
    return { publication: await this.publications.adminRead(id) };
  }

  @ApiOperation({ summary: 'Download a publication’s thumbnail, visible or not' })
  @ApiErrors(403, 404)
  @Get('publications/:id/thumbnail')
  async thumbnail(@Param('id') id: string, @Res() response: Response): Promise<void> {
    sendImage(response, await this.publications.adminAsset(id, THUMBNAIL_ASSET_KEY));
  }

  @ApiOperation({ summary: 'Download a publication’s channel texture, visible or not' })
  @ApiErrors(403, 404)
  @Get('publications/:id/textures/:channel')
  async texture(
    @Param('id') id: string,
    @Param('channel') channel: string,
    @Res() response: Response,
  ): Promise<void> {
    sendImage(response, await this.publications.adminAsset(id, textureKey(channel)));
  }

  @ApiOperation({
    summary: 'Hide or restore a publication',
    description: 'Body: `{ hidden, reason, expectedModerationRevision }`. Recorded in the audit.',
  })
  @ApiErrors(400, 403, 404, 409)
  @Put('publications/:id/moderation')
  async moderate(
    @Param('id') id: string,
    @Body() body: JsonBody,
    @CurrentUser() principal: Principal,
  ): Promise<unknown> {
    const publication = await this.publications.moderate(principal.userId, id, body ?? {});
    this.logger.log(`${publication.moderatorHidden ? 'hid' : 'restored'} "${id}"`);
    return { publication };
  }

  @ApiOperation({
    summary: 'List reports',
    description: '`status` is `open` (default), `resolved` or `all`; `publicationId` narrows it.',
  })
  @ApiErrors(400, 403)
  @Get('reports')
  @Header('Cache-Control', 'no-store')
  reports(@Query() query: QueryParams): Promise<unknown> {
    return this.publications.listReports(query);
  }

  @ApiOperation({
    summary: 'Resolve a report',
    description: 'Body: `{ reason, expectedRevision }`. Recorded in the audit.',
  })
  @ApiErrors(400, 403, 404, 409)
  @Post('reports/:id/resolution')
  @HttpCode(200)
  async resolve(
    @Param('id') id: string,
    @Body() body: JsonBody,
    @CurrentUser() principal: Principal,
  ): Promise<unknown> {
    return { report: await this.publications.resolveReport(principal.userId, id, body ?? {}) };
  }

  @ApiOperation({ summary: 'Read a publisher’s restriction' })
  @ApiErrors(403, 404)
  @Get('publishers/:userId/restriction')
  @Header('Cache-Control', 'no-store')
  async restriction(@Param('userId') userId: string): Promise<unknown> {
    return { restriction: await this.publications.restriction(userId) };
  }

  @ApiOperation({
    summary: 'Restrict or restore a publisher',
    description:
      'Body: `{ restricted, reason, expectedRevision }`. Restricting hides every current ' +
      'publication and blocks publishing; lifting it restores nothing by itself.',
  })
  @ApiErrors(400, 403, 404, 409)
  @Put('publishers/:userId/restriction')
  async restrict(
    @Param('userId') userId: string,
    @Body() body: JsonBody,
    @CurrentUser() principal: Principal,
  ): Promise<unknown> {
    const restriction = await this.publications.setRestriction(
      principal.userId,
      userId,
      body ?? {},
    );
    this.logger.log(`${restriction.restricted ? 'restricted' : 'unrestricted'} a publisher`);
    return { restriction };
  }

  @ApiOperation({
    summary: 'Read the moderation history',
    description: 'Newest first; `targetId` narrows it to one publication, report or account.',
  })
  @ApiErrors(400, 403)
  @Get('audit')
  @Header('Cache-Control', 'no-store')
  audit(@Query() query: QueryParams): Promise<unknown> {
    return this.publications.listAudit(query);
  }
}
