/**
 * The shader REST API.
 *
 * Routes stay thin: parse the request, hand it to `ShaderStorage`, translate a
 * `StorageError` into a status code. All validation lives in `shared/validate`
 * so the client can run the same checks before it ever sends anything.
 *
 * Errors are always `{ error: { code, message, details? } }`.
 */

import express, { type NextFunction, type Request, type Response, type Router } from 'express';

import type { ApiErrorBody } from '@shader-studio/shared/model';
import {
  buildCollectionBundle,
  buildShaderBundle,
  parseBundle,
  validateImportMode,
} from '@shader-studio/shared/validate';
import { ShaderStorage, StorageError } from '../storage';
import { I18N_LOCALES, loadI18nCatalog } from '../i18n-catalog';
import {
  attachmentName,
  BODY_LIMIT,
  channelParam,
  extFromContentType,
  intQuery,
  mimeFromExt,
  param,
  route,
  TEXTURE_BODY_LIMIT,
  THUMBNAIL_BODY_LIMIT,
} from './helpers';

export function createApiRouter(storage: ShaderStorage, i18nDir?: string): Router {
  const api = express.Router();

  api.use(express.json({ limit: BODY_LIMIT }));

  api.get(
    '/i18n/:locale',
    route(async (req, res) => {
      const locale = param(req, 'locale');
      if (!(I18N_LOCALES as readonly string[]).includes(locale)) {
        throw new StorageError('invalid', `Unsupported locale "${locale}"`);
      }
      try {
        res.json({ locale, catalog: await loadI18nCatalog(locale, i18nDir) });
      } catch (error) {
        throw new StorageError(
          'io',
          error instanceof Error ? error.message : 'Failed to load translations',
        );
      }
    }),
  );

  api.get(
    '/shaders',
    route(async (_req, res) => {
      res.json({ shaders: await storage.list() });
    }),
  );

  api.post(
    '/shaders',
    route(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const created = await storage.create({
        name: body['name'],
        description: body['description'],
        controls: body['controls'],
        render: body['render'],
        fragment: body['fragment'],
        vertex: body['vertex'],
        ...('project' in body ? { project: body['project'] } : {}),
      });
      res.status(201).json({ shader: created });
    }),
  );

  api.get(
    '/shaders/:id',
    route(async (req, res) => {
      res.json({ shader: await storage.read(param(req, 'id')) });
    }),
  );

  api.put(
    '/shaders/:id',
    route(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const updated = await storage.update(param(req, 'id'), {
        ...('name' in body ? { name: body['name'] } : {}),
        ...('description' in body ? { description: body['description'] } : {}),
        ...('controls' in body ? { controls: body['controls'] } : {}),
        ...('render' in body ? { render: body['render'] } : {}),
        ...('fragment' in body ? { fragment: body['fragment'] } : {}),
        ...('vertex' in body ? { vertex: body['vertex'] } : {}),
        ...('project' in body ? { project: body['project'] } : {}),
        ...('channels' in body ? { channels: body['channels'] } : {}),
      });
      res.json({ shader: updated });
    }),
  );

  api.delete(
    '/shaders/:id',
    route(async (req, res) => {
      await storage.remove(param(req, 'id'));
      res.status(204).end();
    }),
  );

  api.post(
    '/shaders/:id/duplicate',
    route(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const copy = await storage.duplicate(param(req, 'id'), body['name']);
      res.status(201).json({ shader: copy });
    }),
  );

  api.get(
    '/shaders/:id/presets',
    route(async (req, res) => {
      const shader = await storage.read(param(req, 'id'));
      res.json({ presets: shader.presets });
    }),
  );

  api.post(
    '/shaders/:id/presets',
    route(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const preset = await storage.savePreset(param(req, 'id'), {
        name: body['name'],
        values: body['values'],
        render: body['render'],
      });
      res.status(201).json({ preset });
    }),
  );

  api.delete(
    '/shaders/:id/presets/:presetId',
    route(async (req, res) => {
      await storage.deletePreset(param(req, 'id'), param(req, 'presetId'));
      res.status(204).end();
    }),
  );

  api.put(
    '/shaders/:id/textures/:channel',
    express.raw({ type: 'image/*', limit: TEXTURE_BODY_LIMIT }),
    route(async (req, res) => {
      if (!Buffer.isBuffer(req.body)) {
        throw new StorageError('invalid', 'Expected a raw image body with an image/* Content-Type');
      }
      const shader = await storage.setTexture(param(req, 'id'), channelParam(req), {
        ext: extFromContentType(req.headers['content-type']),
        bytes: req.body,
        width: intQuery(req, 'width'),
        height: intQuery(req, 'height'),
      });
      res.json({ shader });
    }),
  );

  api.delete(
    '/shaders/:id/textures/:channel',
    route(async (req, res) => {
      const shader = await storage.clearTexture(param(req, 'id'), channelParam(req));
      res.json({ shader });
    }),
  );

  api.get(
    '/shaders/:id/textures/:channel',
    route(async (req, res) => {
      const texture = await storage.readTexture(param(req, 'id'), channelParam(req));
      if (!texture) {
        res.status(404).end();
        return;
      }
      res
        .setHeader('Content-Type', mimeFromExt(texture.ext))
        .setHeader('Cache-Control', 'private, max-age=31536000, immutable')
        .send(texture.bytes);
    }),
  );

  api.put(
    '/shaders/:id/thumbnail',
    express.raw({ type: 'image/*', limit: THUMBNAIL_BODY_LIMIT }),
    route(async (req, res) => {
      if (!Buffer.isBuffer(req.body)) {
        throw new StorageError('invalid', 'Expected a raw image body with an image/* Content-Type');
      }
      const shader = await storage.setThumbnail(param(req, 'id'), {
        ext: extFromContentType(req.headers['content-type']),
        bytes: req.body,
      });
      res.json({ shader });
    }),
  );

  api.get(
    '/shaders/:id/thumbnail',
    route(async (req, res) => {
      const thumbnail = await storage.readThumbnail(param(req, 'id'));
      if (!thumbnail) {
        res.status(404).end();
        return;
      }
      // Safe to cache hard: the client always asks for `?v=<thumbnail.updatedAt>`.
      res
        .setHeader('Content-Type', mimeFromExt(thumbnail.ext))
        .setHeader('Cache-Control', 'private, max-age=31536000, immutable')
        .send(thumbnail.bytes);
    }),
  );

  api.get(
    '/shaders/:id/export',
    route(async (req, res) => {
      const payload = await storage.exportOne(param(req, 'id'));
      res
        .setHeader('Content-Disposition', `attachment; filename="${attachmentName(payload.id)}"`)
        .json(buildShaderBundle(payload));
    }),
  );

  api.get(
    '/export',
    route(async (_req, res) => {
      const payloads = await storage.exportAll();
      res
        .setHeader(
          'Content-Disposition',
          'attachment; filename="shader-studio-collection.shader.json"',
        )
        .json(buildCollectionBundle(payloads));
    }),
  );

  api.post(
    '/import',
    route(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;

      const raw = 'bundle' in body ? body['bundle'] : body;

      const mode = validateImportMode(body['mode']);
      if (!mode.ok) {
        throw new StorageError('invalid', 'Invalid import mode', mode.errors);
      }

      const parsed = parseBundle(raw);
      if (!parsed.ok) {
        throw new StorageError('invalid', 'The bundle could not be imported', parsed.errors);
      }

      const result = await storage.importPayloads(parsed.value, mode.value);
      res.status(201).json(result);
    }),
  );

  api.use((_req, res) => {
    const body: ApiErrorBody = {
      error: { code: 'not_found', message: 'No such API route' },
    };
    res.status(404).json(body);
  });

  api.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    if (error instanceof StorageError) {
      const body: ApiErrorBody = {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details.length ? { details: error.details } : {}),
        },
      };
      res.status(error.status).json(body);
      return;
    }

    if (error instanceof SyntaxError && 'body' in error) {
      const body: ApiErrorBody = {
        error: { code: 'invalid', message: 'Request body is not valid JSON' },
      };
      res.status(400).json(body);
      return;
    }

    console.error('[api] unhandled error', error);
    const body: ApiErrorBody = {
      error: { code: 'internal', message: 'Internal server error' },
    };
    res.status(500).json(body);
  });

  return api;
}
