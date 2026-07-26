import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
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

import { SHADER_LIBRARY } from './api.constants';

type JsonBody = Record<string, unknown>;

@Controller()
export class ApiController {
  constructor(@Inject(SHADER_LIBRARY) private readonly storage: ShaderLibrary) {}

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

  @Get('shaders')
  async list(): Promise<unknown> {
    return { shaders: await this.storage.list() };
  }

  @Post('shaders')
  async create(@Body() body: JsonBody | undefined, @Res() response: Response): Promise<void> {
    const input = body ?? {};
    const created = await this.storage.create({
      name: input['name'],
      description: input['description'],
      controls: input['controls'],
      render: input['render'],
      fragment: input['fragment'],
      vertex: input['vertex'],
      ...('project' in input ? { project: input['project'] } : {}),
    });
    response.status(201).json({ shader: created });
  }

  @Get('shaders/:id')
  async read(@Param('id') id: string): Promise<unknown> {
    return { shader: await this.storage.read(id) };
  }

  @Put('shaders/:id')
  async update(@Param('id') id: string, @Body() body: JsonBody | undefined): Promise<unknown> {
    const input = body ?? {};
    const updated = await this.storage.update(id, {
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

  @Delete('shaders/:id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.storage.remove(id);
  }

  @Post('shaders/:id/duplicate')
  async duplicate(
    @Param('id') id: string,
    @Body() body: JsonBody | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const copy = await this.storage.duplicate(id, body?.['name']);
    response.status(201).json({ shader: copy });
  }

  @Get('shaders/:id/presets')
  async presets(@Param('id') id: string): Promise<unknown> {
    return { presets: (await this.storage.read(id)).presets };
  }

  @Post('shaders/:id/presets')
  async savePreset(
    @Param('id') id: string,
    @Body() body: JsonBody | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const input = body ?? {};
    const preset = await this.storage.savePreset(id, {
      name: input['name'],
      values: input['values'],
      render: input['render'],
    });
    response.status(201).json({ preset });
  }

  @Delete('shaders/:id/presets/:presetId')
  @HttpCode(204)
  async deletePreset(@Param('id') id: string, @Param('presetId') presetId: string): Promise<void> {
    await this.storage.deletePreset(id, presetId);
  }

  @Put('shaders/:id/textures/:channel')
  async setTexture(
    @Param('id') id: string,
    @Param('channel') rawChannel: string,
    @Query('width') rawWidth: string | undefined,
    @Query('height') rawHeight: string | undefined,
    @Req() request: Request,
  ): Promise<unknown> {
    const body = request.body as unknown;
    if (!Buffer.isBuffer(body)) {
      throw new StorageError('invalid', 'Expected a raw image body with an image/* Content-Type');
    }
    const shader = await this.storage.setTexture(id, channel(rawChannel), {
      ext: imageExtension(request.headers['content-type']),
      bytes: body,
      width: positiveInteger(rawWidth, 'width'),
      height: positiveInteger(rawHeight, 'height'),
    });
    return { shader };
  }

  @Delete('shaders/:id/textures/:channel')
  async clearTexture(
    @Param('id') id: string,
    @Param('channel') rawChannel: string,
  ): Promise<unknown> {
    return { shader: await this.storage.clearTexture(id, channel(rawChannel)) };
  }

  @Get('shaders/:id/textures/:channel')
  async texture(
    @Param('id') id: string,
    @Param('channel') rawChannel: string,
    @Res() response: Response,
  ): Promise<void> {
    const texture = await this.storage.readTexture(id, channel(rawChannel));
    if (!texture) {
      response.status(404).end();
      return;
    }
    response
      .setHeader('Content-Type', mimeFromExt(texture.ext))
      .setHeader('Cache-Control', 'private, max-age=31536000, immutable')
      .send(Buffer.from(texture.bytes));
  }

  @Put('shaders/:id/thumbnail')
  async setThumbnail(@Param('id') id: string, @Req() request: Request): Promise<unknown> {
    const body = request.body as unknown;
    if (!Buffer.isBuffer(body)) {
      throw new StorageError('invalid', 'Expected a raw image body with an image/* Content-Type');
    }
    return {
      shader: await this.storage.setThumbnail(id, {
        ext: imageExtension(request.headers['content-type']),
        bytes: body,
      }),
    };
  }

  @Get('shaders/:id/thumbnail')
  async thumbnail(@Param('id') id: string, @Res() response: Response): Promise<void> {
    const thumbnail = await this.storage.readThumbnail(id);
    if (!thumbnail) {
      response.status(404).end();
      return;
    }
    response
      .setHeader('Content-Type', mimeFromExt(thumbnail.ext))
      .setHeader('Cache-Control', 'private, max-age=31536000, immutable')
      .send(Buffer.from(thumbnail.bytes));
  }

  @Get('shaders/:id/export')
  async exportShader(@Param('id') id: string, @Res() response: Response): Promise<void> {
    const payload = await this.storage.exportOne(id);
    response
      .setHeader('Content-Disposition', `attachment; filename="${attachmentName(payload.id)}"`)
      .json(buildShaderBundle(payload));
  }

  @Get('export')
  @Header('Content-Disposition', 'attachment; filename="shader-studio-collection.shader.json"')
  async exportAll(): Promise<unknown> {
    return buildCollectionBundle(await this.storage.exportAll());
  }

  @Post('import')
  async import(@Body() body: JsonBody | undefined, @Res() response: Response): Promise<void> {
    const input = body ?? {};
    const raw = 'bundle' in input ? input['bundle'] : input;
    const mode = validateImportMode(input['mode']);
    if (!mode.ok) throw new StorageError('invalid', 'Invalid import mode', mode.errors);

    const parsed = parseBundle(raw);
    if (!parsed.ok) {
      throw new StorageError('invalid', 'The bundle could not be imported', parsed.errors);
    }

    response.status(201).json(await this.storage.importPayloads(parsed.value, mode.value));
  }

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
      throw new StorageError('io', error instanceof Error ? error.message : String(error));
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
