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

import type { ApiErrorBody } from '../shared/model';
import { buildCollectionBundle, buildShaderBundle, parseBundle, validateImportMode } from '../shared/validate';
import { ShaderStorage, StorageError } from './storage';

/** Bundles carry GLSL for every shader they hold, so the cap is generous. */
const BODY_LIMIT = '8mb';

/** Turn a name into something safe to put in a Content-Disposition header. */
function attachmentName(name: string): string {
  const ascii = name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'shaders';
  return `${ascii}.shader.json`;
}

/** Async route handlers, with rejections funnelled to the error middleware. */
function route(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };
}

/**
 * Read a route parameter as a string.
 *
 * Express types params as `string | string[]` behind an index signature, since
 * a wildcard segment can repeat. Ours never do, and an empty string falls
 * straight through to `validateId`, which rejects it.
 */
function param(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[] | undefined>)[name];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export function createApiRouter(storage: ShaderStorage): Router {
  const api = express.Router();

  api.use(express.json({ limit: BODY_LIMIT }));

  // --- Collection ---------------------------------------------------------

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
      });
      res.status(201).json({ shader: created });
    }),
  );

  // --- One shader ---------------------------------------------------------

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
        // `undefined` means "leave alone", so only forward keys that are present.
        ...('name' in body ? { name: body['name'] } : {}),
        ...('description' in body ? { description: body['description'] } : {}),
        ...('controls' in body ? { controls: body['controls'] } : {}),
        ...('render' in body ? { render: body['render'] } : {}),
        ...('fragment' in body ? { fragment: body['fragment'] } : {}),
        ...('vertex' in body ? { vertex: body['vertex'] } : {}),
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

  // --- Presets ------------------------------------------------------------

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

  // --- Import / export ----------------------------------------------------

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
        .setHeader('Content-Disposition', 'attachment; filename="shader-studio-collection.shader.json"')
        .json(buildCollectionBundle(payloads));
    }),
  );

  api.post(
    '/import',
    route(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;

      // Accept the bundle either wrapped (`{ bundle, mode }`) or bare, so a
      // file exported from the app can be POSTed back untouched.
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

  // --- Errors -------------------------------------------------------------

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

    // A malformed JSON body surfaces here as a SyntaxError from body-parser.
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
