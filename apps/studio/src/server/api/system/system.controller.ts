/** Readiness and translations: public, and the same whether or not anyone is signed in. */

import { Controller, Get, Header, Inject, Logger, Param, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { I18N_LOCALES, loadI18nCatalog } from '@shadergrove/backend/i18n';
import { ShaderLibrary, StorageError } from '@shadergrove/backend/library';

import { SHADER_LIBRARY } from '../core/api.constants';
import { Public } from '../core/auth.guard';
import { ApiErrors } from '../core/swagger';

@ApiTags('health')
@Controller()
export class HealthController {
  private readonly logger = new Logger('api');

  constructor(@Inject(SHADER_LIBRARY) private readonly storage: ShaderLibrary) {}

  @ApiOperation({ summary: 'Check API and database readiness' })
  @ApiErrors(503)
  @Public()
  @Get('health')
  @Header('Cache-Control', 'no-store')
  async health(@Res() response: Response): Promise<void> {
    try {
      await this.storage.checkHealth();
      response.json({ status: 'ok' });
    } catch (error) {
      this.logger.error(
        'database readiness check failed',
        error instanceof Error ? error.stack : String(error),
      );
      response.status(503).json({ error: { code: 'internal', message: 'Service unavailable' } });
    }
  }
}

@ApiTags('i18n')
@Controller()
export class I18nController {
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
}
