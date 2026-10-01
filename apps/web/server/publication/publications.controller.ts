/**
 * The HTTP face of public Explore: anonymous reads of published snapshots, the
 * owner's publish/unpublish, copy and report for any verified account, and the
 * moderation routes.
 *
 * Three things here are deliberately unlike the private shader API next door:
 *
 *  - The public reads are `@Public()` and answer `Cache-Control: no-store`. A
 *    publication can be hidden at any moment, and a cached copy of its detail
 *    or its textures would keep serving it after that.
 *  - Every cookie-authenticated write is checked against the trusted origins.
 *    Better Auth does that for its own endpoints only; these routes are Nest's,
 *    so without `TrustedOriginGuard` a third-party page could publish or
 *    moderate on the back of a signed-in visitor's cookie.
 *  - Moderation is granted by the server's own list of account ids and nothing
 *    else — not a claim in the request, not anything the client was told.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Injectable,
  Logger,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { fromNodeHeaders } from 'better-auth/node';

import { StorageError } from '@shadergrove/backend/library';
import {
  textureAssetKey,
  THUMBNAIL_ASSET_KEY,
  type AssetKey,
} from '@shadergrove/backend/persistence';
import type { PublicationLibrary } from '@shadergrove/backend/publication';
import type { ExploreCapabilities } from '@shadergrove/shared/publication';
import { buildShaderBundle, mimeFromExt, slugify } from '@shadergrove/shared/validate';

import { AUTH_INSTANCE, EXPLORE } from '../api/api.constants';
import { AllowUnverified, CurrentUser, Public } from '../api/auth.guard';
import { ApiErrors } from '../api/swagger';
import { resolvePrincipal, type Auth, type Principal } from '../auth/auth';
import { windowLimiter } from '../auth/desktop-handoff';

/** What the API is given about Explore. No `publications` means the feature is off. */
export interface Explore {
  readonly adminUserIds: ReadonlySet<string>;
  readonly publications?: PublicationLibrary;
}

export const EXPLORE_OFF: Explore = { adminUserIds: new Set() };

type JsonBody = Record<string, unknown> | undefined;
type QueryParams = Record<string, unknown>;

const HOUR_MS = 60 * 60 * 1000;

function isAdmin(explore: Explore, principal: Principal | null | undefined): boolean {
  return Boolean(principal?.emailVerified && explore.adminUserIds.has(principal.userId));
}

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

/** Always registered, so the web app can ask whether Explore exists at all. */
@ApiTags('explore')
@Controller()
export class CapabilitiesController {
  constructor(
    @Inject(EXPLORE) private readonly explore: Explore,
    @Inject(AUTH_INSTANCE) private readonly auth: Auth,
  ) {}

  @ApiOperation({
    summary: 'What this server offers the caller',
    description: '`admin` is only ever true for a signed-in, verified moderator.',
  })
  @Public()
  @Get('capabilities')
  @Header('Cache-Control', 'no-store')
  async capabilities(@Req() request: Request): Promise<ExploreCapabilities> {
    if (!this.explore.publications) return { publicExplore: false, admin: false };
    // The route is public, so the guard resolved nobody; look, but never require.
    const principal = await resolvePrincipal(this.auth, fromNodeHeaders(request.headers));
    return { publicExplore: true, admin: isAdmin(this.explore, principal) };
  }
}

@ApiTags('explore')
@Controller()
@UseGuards(TrustedOriginGuard)
export class PublicationsController {
  private readonly logger = new Logger('explore');
  // Per account, per process — the same shape as the sign-in limiter.
  private readonly limits = {
    publish: windowLimiter(HOUR_MS, 30),
    copy: windowLimiter(HOUR_MS, 60),
    report: windowLimiter(HOUR_MS, 10),
  };

  constructor(
    @Inject(EXPLORE) private readonly explore: Explore,
    @Inject(AUTH_INSTANCE) private readonly auth: Auth,
  ) {}

  private get publications(): PublicationLibrary {
    return this.explore.publications!;
  }

  private throttle(kind: keyof PublicationsController['limits'], principal: Principal): void {
    if (this.auth.options.rateLimit?.enabled && !this.limits[kind](principal.userId)) {
      throw new StorageError('rate_limited', 'Too many requests. Try again later.');
    }
  }

  // --- anonymous ------------------------------------------------------------

  @ApiOperation({
    summary: 'List public shaders',
    description:
      'Newest first. `search` matches the title, `limit` is capped at 50, and `cursor` is the ' +
      '`nextCursor` of the previous page.',
  })
  @ApiErrors(400)
  @Public()
  @Get('publications')
  @Header('Cache-Control', 'no-store')
  list(@Query() query: QueryParams): Promise<unknown> {
    return this.publications.listPublic(query);
  }

  @ApiOperation({
    summary: 'Read one public shader',
    description: 'Hidden, unpublished and unknown ids are all the same 404.',
  })
  @ApiErrors(404)
  @Public()
  @Get('publications/:id')
  @Header('Cache-Control', 'no-store')
  async read(@Param('id') id: string): Promise<unknown> {
    return { publication: await this.publications.readPublic(id) };
  }

  @ApiOperation({ summary: 'Download a public shader’s thumbnail' })
  @ApiErrors(404)
  @Public()
  @Get('publications/:id/thumbnail')
  async thumbnail(@Param('id') id: string, @Res() response: Response): Promise<void> {
    sendImage(response, await this.publications.readPublicAsset(id, THUMBNAIL_ASSET_KEY));
  }

  @ApiOperation({ summary: 'Download a public shader’s channel texture' })
  @ApiErrors(404)
  @Public()
  @Get('publications/:id/textures/:channel')
  async texture(
    @Param('id') id: string,
    @Param('channel') channel: string,
    @Res() response: Response,
  ): Promise<void> {
    sendImage(response, await this.publications.readPublicAsset(id, textureKey(channel)));
  }

  @ApiOperation({
    summary: 'Export a public shader',
    description:
      'A `shader-studio/v3` bundle with a `publication` block naming the author and license.',
  })
  @ApiErrors(404)
  @Public()
  @Get('publications/:id/export')
  async export(@Param('id') id: string, @Res() response: Response): Promise<void> {
    const { publication, shader } = await this.publications.exportPublic(id);
    const { shader: _snapshot, ...credits } = publication;
    const name = slugify(publication.title);
    response
      .setHeader('Cache-Control', 'no-store')
      .setHeader('Content-Disposition', `attachment; filename="${name}.shader.json"`)
      .json({ ...buildShaderBundle(shader), publication: credits });
  }

  // --- the owner ------------------------------------------------------------

  @ApiOperation({
    summary: 'Publication status of one of your shaders',
    description: 'Its publication if any, where it was copied from, and whether you may publish.',
  })
  @ApiErrors(404)
  @AllowUnverified()
  @Get('shaders/:id/publication')
  @Header('Cache-Control', 'no-store')
  status(@Param('id') id: string, @CurrentUser() principal: Principal): Promise<unknown> {
    return this.publications.status(principal.userId, id);
  }

  @ApiOperation({
    summary: 'Publish, update or republish a shader',
    description:
      'Freezes the saved shader at `expectedRevision` as its public snapshot. Body: ' +
      '`{ expectedRevision, authorLabel, license, attribution?, rightsConfirmed: true }`. ' +
      '201 on first publication, 200 after; the public id never changes.',
  })
  @ApiErrors(400, 403, 404, 409, 429)
  @Put('shaders/:id/publication')
  async publish(
    @Param('id') id: string,
    @Body() body: JsonBody,
    @Res() response: Response,
    @CurrentUser() principal: Principal,
  ): Promise<void> {
    this.throttle('publish', principal);
    const { publication, created } = await this.publications.publish(
      principal.userId,
      id,
      body ?? {},
    );
    this.logger.log(`published "${publication.id}" revision ${publication.revision}`);
    response.status(created ? 201 : 200).json({ publication });
  }

  @ApiOperation({
    summary: 'Unpublish a shader',
    description: 'Takes it out of Explore. The public id is kept for a later republish.',
  })
  @ApiErrors(404)
  @Delete('shaders/:id/publication')
  async unpublish(@Param('id') id: string, @CurrentUser() principal: Principal): Promise<unknown> {
    const publication = await this.publications.unpublish(principal.userId, id);
    this.logger.log(`unpublished "${publication.id}"`);
    return { publication };
  }

  // --- any verified account -------------------------------------------------

  @ApiOperation({
    summary: 'Copy a public shader into your library',
    description: 'Always a new private shader; the source and its license are recorded on it.',
  })
  @ApiErrors(404, 429)
  @Post('publications/:id/copy')
  async copy(
    @Param('id') id: string,
    @Res() response: Response,
    @CurrentUser() principal: Principal,
  ): Promise<void> {
    this.throttle('copy', principal);
    const shader = await this.publications.copy(principal.userId, id);
    response.status(201).json({ shader });
  }

  @ApiOperation({
    summary: 'Report a public shader',
    description:
      'Body: `{ reason, body? }`. One open report per account and publication (409 otherwise).',
  })
  @ApiErrors(400, 404, 409, 429)
  @Post('publications/:id/reports')
  async report(
    @Param('id') id: string,
    @Body() body: JsonBody,
    @Res() response: Response,
    @CurrentUser() principal: Principal,
  ): Promise<void> {
    this.throttle('report', principal);
    const report = await this.publications.report(principal.userId, id, body ?? {});
    response.status(201).json({ report });
  }
}

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

function textureKey(raw: string): AssetKey {
  if (!/^[0-3]$/.test(raw)) throw new StorageError('not_found', 'Publication was not found');
  return textureAssetKey(Number(raw));
}

function sendImage(response: Response, image: { bytes: Uint8Array; ext: string }): void {
  response
    .setHeader('Content-Type', mimeFromExt(image.ext))
    .setHeader('Cache-Control', 'no-store')
    .send(Buffer.from(image.bytes));
}
