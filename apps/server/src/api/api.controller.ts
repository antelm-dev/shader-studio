import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Logger,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { I18N_LOCALES, loadI18nCatalog } from '@shader-studio/backend/i18n';
import { ShaderLibrary, StorageError } from '@shader-studio/backend/library';
import type { ShaderPayload } from '@shader-studio/shared/model';
import {
  buildCollectionBundle,
  buildShaderBundle,
  extFromMime,
  mimeFromExt,
  parseBundle,
  validateImportMode,
} from '@shader-studio/shared/validate';

import { AUDITOR, SHADER_LIBRARY } from './api.constants';
import { AllowUnverified, CurrentUser, Public } from './auth.guard';
import { ApiErrors, IMAGE_BODY_SCHEMA, SHADER_BODY_SCHEMA } from './swagger';
import type { Auditor } from '../auth/audit';
import type { Principal } from '../auth/auth';

type JsonBody = Record<string, unknown>;

@ApiTags('shaders')
@Controller()
export class ApiController {
  private readonly logger = new Logger('api');

  constructor(
    @Inject(SHADER_LIBRARY) private readonly storage: ShaderLibrary,
    @Inject(AUDITOR) private readonly auditor: Auditor,
  ) {}

  private libraryFor(principal: Principal): ShaderLibrary {
    return this.storage.as({ userId: principal.userId });
  }

  @ApiTags('i18n')
  @ApiOperation({
    summary: 'Read a translation catalog',
    description: 'Returns `{ locale, catalog }` for a supported locale.',
  })
  @ApiErrors(400, 500)
  @Public()
  @Get('i18n/:locale')
  async i18n(@Param('locale') locale: string): Promise<unknown> {
    if (!(I18N_LOCALES as readonly string[]).includes(locale)) {
      throw new StorageError('invalid', `Unsupported locale "${locale}"`);
    }
    try {
      return { locale, catalog: await loadI18nCatalog(locale) };
    } catch (error) {
      throw new StorageError(
        'io',
        error instanceof Error ? error.message : 'Failed to load translations',
      );
    }
  }

  @ApiOperation({ summary: 'List every shader', description: 'Summaries only, not full sources.' })
  @AllowUnverified()
  @Get('shaders')
  async list(@CurrentUser() principal: Principal): Promise<unknown> {
    return { shaders: await this.libraryFor(principal).list() };
  }

  @ApiOperation({
    summary: 'Create a shader',
    description: 'The id is slugged from the name; defaults fill in anything omitted.',
  })
  @ApiBody({ schema: SHADER_BODY_SCHEMA })
  @ApiErrors(400)
  @Post('shaders')
  async create(
    @Body() body: JsonBody | undefined,
    @Res() response: Response,
    @CurrentUser() principal: Principal,
  ): Promise<void> {
    const input = body ?? {};
    const created = await this.libraryFor(principal).create({
      name: input['name'],
      description: input['description'],
      controls: input['controls'],
      render: input['render'],
      fragment: input['fragment'],
      vertex: input['vertex'],
      ...('project' in input ? { project: input['project'] } : {}),
    });
    // The generated id is not in the request URL, so the access log cannot show it.
    this.logger.log(`created shader "${created.id}"`);
    response.status(201).json({ shader: created });
  }

  @ApiOperation({ summary: 'Read one shader', description: 'Full record, including presets.' })
  @ApiErrors(404)
  @AllowUnverified()
  @Get('shaders/:id')
  async read(@Param('id') id: string, @CurrentUser() principal: Principal): Promise<unknown> {
    return { shader: await this.libraryFor(principal).read(id) };
  }

  @ApiOperation({
    summary: 'Update a shader',
    description:
      'Only the fields present in the body are written. Pass `expectedRevision` to be ' +
      'told with a 409 when someone else has saved since you read.',
  })
  @ApiBody({ schema: SHADER_BODY_SCHEMA })
  @ApiErrors(400, 404, 409)
  @Put('shaders/:id')
  async update(
    @Param('id') id: string,
    @Body() body: JsonBody | undefined,
    @CurrentUser() principal: Principal,
  ): Promise<unknown> {
    const input = body ?? {};
    const updated = await this.libraryFor(principal).update(id, {
      ...('name' in input ? { name: input['name'] } : {}),
      ...('description' in input ? { description: input['description'] } : {}),
      ...('controls' in input ? { controls: input['controls'] } : {}),
      ...('render' in input ? { render: input['render'] } : {}),
      ...('fragment' in input ? { fragment: input['fragment'] } : {}),
      ...('vertex' in input ? { vertex: input['vertex'] } : {}),
      ...('project' in input ? { project: input['project'] } : {}),
      ...('channels' in input ? { channels: input['channels'] } : {}),
      ...('expectedRevision' in input ? { expectedRevision: input['expectedRevision'] } : {}),
    });
    return { shader: updated };
  }

  @ApiOperation({
    summary: 'Delete a shader',
    description: 'Removes the shader with its presets, textures and thumbnail.',
  })
  @ApiErrors(404)
  @Delete('shaders/:id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @CurrentUser() principal: Principal): Promise<void> {
    await this.libraryFor(principal).remove(id);
    this.logger.log(`deleted shader "${id}"`);
    // Recorded after the fact, so a refused delete leaves no line claiming one
    // happened. A shader has no undo — this is the only trace it existed.
    this.auditor.record('shader.deleted', { userId: principal.userId, subject: id });
  }

  @ApiOperation({
    summary: 'Duplicate a shader',
    description: 'Copies sources, presets and textures under a new id.',
  })
  @ApiBody({
    required: false,
    schema: { type: 'object', properties: { name: { type: 'string' } } },
  })
  @ApiErrors(400, 404)
  @Post('shaders/:id/duplicate')
  async duplicate(
    @Param('id') id: string,
    @Body() body: JsonBody | undefined,
    @Res() response: Response,
    @CurrentUser() principal: Principal,
  ): Promise<void> {
    const copy = await this.libraryFor(principal).duplicate(id, body?.['name']);
    this.logger.log(`duplicated shader "${id}" to "${copy.id}"`);
    response.status(201).json({ shader: copy });
  }

  @ApiTags('presets')
  @ApiOperation({ summary: "List a shader's presets" })
  @ApiErrors(404)
  @AllowUnverified()
  @Get('shaders/:id/presets')
  async presets(@Param('id') id: string, @CurrentUser() principal: Principal): Promise<unknown> {
    return { presets: (await this.libraryFor(principal).read(id)).presets };
  }

  @ApiTags('presets')
  @ApiOperation({
    summary: 'Save a preset',
    description: 'Stores a named snapshot of the control values and render settings.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name', 'values'],
      properties: {
        name: { type: 'string' },
        values: { type: 'object', description: 'Control values, keyed by uniform name.' },
        render: { type: 'object', description: 'Optional render settings to store with it.' },
      },
    },
  })
  @ApiErrors(400, 404)
  @Post('shaders/:id/presets')
  async savePreset(
    @Param('id') id: string,
    @Body() body: JsonBody | undefined,
    @Res() response: Response,
    @CurrentUser() principal: Principal,
  ): Promise<void> {
    const input = body ?? {};
    const preset = await this.libraryFor(principal).savePreset(id, {
      name: input['name'],
      values: input['values'],
      render: input['render'],
    });
    response.status(201).json({ preset });
  }

  @ApiTags('presets')
  @ApiOperation({ summary: 'Delete a preset' })
  @ApiErrors(404)
  @Delete('shaders/:id/presets/:presetId')
  @HttpCode(204)
  async deletePreset(
    @Param('id') id: string,
    @Param('presetId') presetId: string,
    @CurrentUser() principal: Principal,
  ): Promise<void> {
    await this.libraryFor(principal).deletePreset(id, presetId);
  }

  @ApiTags('textures')
  @ApiOperation({
    summary: 'Upload a channel texture',
    description: 'Raw image bytes for channel 0-3, with the pixel size as query parameters.',
  })
  @ApiConsumes('image/png', 'image/jpeg', 'image/webp', 'image/gif')
  @ApiBody({ schema: IMAGE_BODY_SCHEMA })
  @ApiErrors(400, 404)
  @Put('shaders/:id/textures/:channel')
  async setTexture(
    @Param('id') id: string,
    @Param('channel') rawChannel: string,
    @Query('width') rawWidth: string | undefined,
    @Query('height') rawHeight: string | undefined,
    @Req() request: Request,
    @CurrentUser() principal: Principal,
  ): Promise<unknown> {
    const body = request.body as unknown;
    if (!Buffer.isBuffer(body)) {
      throw new StorageError('invalid', 'Expected a raw image body with an image/* Content-Type');
    }
    const shader = await this.libraryFor(principal).setTexture(id, channel(rawChannel), {
      ext: imageExtension(request.headers['content-type']),
      bytes: body,
      width: positiveInteger(rawWidth, 'width'),
      height: positiveInteger(rawHeight, 'height'),
    });
    return { shader };
  }

  @ApiTags('textures')
  @ApiOperation({ summary: 'Clear a channel texture' })
  @ApiErrors(400, 404)
  @Delete('shaders/:id/textures/:channel')
  async clearTexture(
    @Param('id') id: string,
    @Param('channel') rawChannel: string,
    @CurrentUser() principal: Principal,
  ): Promise<unknown> {
    return { shader: await this.libraryFor(principal).clearTexture(id, channel(rawChannel)) };
  }

  @ApiTags('textures')
  @ApiOperation({
    summary: 'Download a channel texture',
    description: 'The image bytes, or 404 when the channel is empty.',
  })
  @ApiProduces('image/png', 'image/jpeg', 'image/webp', 'image/gif')
  @ApiErrors(400, 404)
  @Get('shaders/:id/textures/:channel')
  @AllowUnverified()
  async texture(
    @Param('id') id: string,
    @Param('channel') rawChannel: string,
    @Res() response: Response,
    @CurrentUser() principal: Principal,
  ): Promise<void> {
    const texture = await this.libraryFor(principal).readTexture(id, channel(rawChannel));
    if (!texture) {
      response.status(404).end();
      return;
    }
    response
      .setHeader('Content-Type', mimeFromExt(texture.ext))
      .setHeader('Cache-Control', 'private, max-age=31536000, immutable')
      .send(Buffer.from(texture.bytes));
  }

  @ApiTags('textures')
  @ApiOperation({ summary: 'Upload the shader thumbnail' })
  @ApiConsumes('image/png', 'image/jpeg', 'image/webp')
  @ApiBody({ schema: IMAGE_BODY_SCHEMA })
  @ApiErrors(400, 404)
  @Put('shaders/:id/thumbnail')
  async setThumbnail(
    @Param('id') id: string,
    @Req() request: Request,
    @CurrentUser() principal: Principal,
  ): Promise<unknown> {
    const body = request.body as unknown;
    if (!Buffer.isBuffer(body)) {
      throw new StorageError('invalid', 'Expected a raw image body with an image/* Content-Type');
    }
    return {
      shader: await this.libraryFor(principal).setThumbnail(id, {
        ext: imageExtension(request.headers['content-type']),
        bytes: body,
      }),
    };
  }

  @ApiTags('textures')
  @ApiOperation({ summary: 'Download the shader thumbnail' })
  @ApiProduces('image/png', 'image/jpeg', 'image/webp')
  @ApiErrors(404)
  @Get('shaders/:id/thumbnail')
  @AllowUnverified()
  async thumbnail(
    @Param('id') id: string,
    @Res() response: Response,
    @CurrentUser() principal: Principal,
  ): Promise<void> {
    const thumbnail = await this.libraryFor(principal).readThumbnail(id);
    if (!thumbnail) {
      response.status(404).end();
      return;
    }
    response
      .setHeader('Content-Type', mimeFromExt(thumbnail.ext))
      .setHeader('Cache-Control', 'private, max-age=31536000, immutable')
      .send(Buffer.from(thumbnail.bytes));
  }

  @ApiTags('transfer')
  @ApiOperation({
    summary: 'Export one shader',
    description: 'A `shader-studio/v3` bundle, served as a file attachment.',
  })
  @ApiErrors(404)
  @Get('shaders/:id/export')
  @AllowUnverified()
  async exportShader(
    @Param('id') id: string,
    @Res() response: Response,
    @CurrentUser() principal: Principal,
  ): Promise<void> {
    const payload = await this.libraryFor(principal).exportOne(id);
    response
      .setHeader('Content-Disposition', `attachment; filename="${attachmentName(payload.id)}"`)
      .json(buildShaderBundle(payload));
  }

  @ApiTags('transfer')
  @ApiOperation({ summary: 'Export the whole library', description: 'A collection bundle.' })
  @Get('export')
  @Header('Content-Disposition', 'attachment; filename="shader-studio-collection.shader.json"')
  @AllowUnverified()
  async exportAll(@CurrentUser() principal: Principal): Promise<unknown> {
    return buildCollectionBundle(await this.libraryFor(principal).exportAll());
  }

  @ApiTags('transfer')
  @ApiOperation({
    summary: 'Import a bundle',
    description:
      'Accepts a shader or collection bundle, either wrapped as `{ bundle }` or posted bare. ' +
      '`rename` keeps existing shaders and imports alongside them; `overwrite` replaces on id.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        bundle: { type: 'object', description: 'The bundle; omit to post it at the top level.' },
        mode: { type: 'string', enum: ['rename', 'overwrite'], default: 'rename' },
      },
    },
  })
  @ApiErrors(400)
  @Post('import')
  async import(
    @Body() body: JsonBody | undefined,
    @Res() response: Response,
    @CurrentUser() principal: Principal,
  ): Promise<void> {
    const input = body ?? {};
    const raw = 'bundle' in input ? input['bundle'] : input;
    const mode = validateImportMode(input['mode']);
    if (!mode.ok) throw new StorageError('invalid', 'Invalid import mode', mode.errors);

    const parsed = parseBundle(raw);
    if (!parsed.ok) {
      throw new StorageError('invalid', 'The bundle could not be imported', parsed.errors);
    }

    const result = await this.libraryFor(principal).importPayloads(parsed.value, mode.value);
    const replaced = result.imported.filter((entry) => entry.replaced).length;
    this.logger.log(
      `imported ${result.imported.length} shader(s) in "${mode.value}" mode (${replaced} replaced)`,
    );
    response.status(201).json(result);
  }

  @ApiTags('transfer')
  @ApiOperation({
    summary: 'Convert a Shadertoy shader',
    description:
      'Fetches the shader from the Shadertoy API with the caller’s own key and returns it as a ' +
      'bundle plus any conversion warnings. Nothing is stored — POST the bundle to /import to keep it.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['idOrUrl', 'apiKey'],
      properties: {
        idOrUrl: { type: 'string', example: 'https://www.shadertoy.com/view/Ms2SD1' },
        apiKey: { type: 'string', description: 'Your Shadertoy API key. Never stored.' },
      },
    },
  })
  @ApiErrors(400, 500)
  @Post('import/shadertoy')
  async importShadertoy(
    @Body() body: JsonBody | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const input = body ?? {};
    const idOrUrl = requiredString(input, 'idOrUrl');
    const apiKey = requiredString(input, 'apiKey');

    let result: { payload: ShaderPayload; warnings: string[] };
    try {
      const { importShadertoyShader } = await import('@shader-studio/shared/shadertoy-api');
      result = await importShadertoyShader(idOrUrl, apiKey, { fetch });
    } catch (error) {
      this.logger.warn(`shadertoy import of "${idOrUrl}" failed: ${String(error)}`);
      throw new StorageError('io', error instanceof Error ? error.message : String(error));
    }

    for (const warning of result.warnings) {
      this.logger.warn(`shadertoy import of "${idOrUrl}": ${warning}`);
    }

    response
      .status(201)
      .json({ bundle: buildShaderBundle(result.payload), warnings: result.warnings });
  }
}

function attachmentName(name: string): string {
  const ascii = name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'shaders';
  return `${ascii}.shader.json`;
}

function channel(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 3) {
    throw new StorageError('invalid', `Invalid channel index "${raw}"`);
  }
  return value;
}

function imageExtension(contentType: string | undefined): string {
  const extension = extFromMime(contentType);
  if (!extension) {
    throw new StorageError('invalid', `Unsupported image type "${contentType ?? 'unknown'}"`);
  }
  return extension;
}

function positiveInteger(raw: string | undefined, name: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new StorageError('invalid', `Query parameter "${name}" must be a positive number`);
  }
  return Math.round(value);
}

function requiredString(body: JsonBody, name: string): string {
  const value = body[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new StorageError('invalid', `"${name}" must be a non-empty string`);
  }
  return value;
}
