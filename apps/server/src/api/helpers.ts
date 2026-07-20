import type { NextFunction, Request, Response } from 'express';

import { extFromMime } from '@shader-studio/shared/validate';
import { StorageError } from '@shader-studio/backend/storage';

// A textured shader's bundle inlines its channel images as base64 (~33%
// inflation), and a collection can hold many shaders — comfortably larger
// than the old text-only limit.
export const BODY_LIMIT = '64mb';
/** Raw image uploads travel outside JSON, so they get their own (smaller) limit. */
export const TEXTURE_BODY_LIMIT = '4mb';
/** A 480×270 preview. Tighter still — anything near this is already suspect. */
export const THUMBNAIL_BODY_LIMIT = '1mb';

export { mimeFromExt } from '@shader-studio/shared/validate';

export function attachmentName(name: string): string {
  const ascii = name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'shaders';
  return `${ascii}.shader.json`;
}

export function route(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };
}

export function param(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[] | undefined>)[name];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

/** Parses `:channel` into 0-3, throwing the same error shape as any other bad input. */
export function channelParam(req: Request): number {
  const raw = param(req, 'channel');
  const index = Number(raw);
  if (!Number.isInteger(index) || index < 0 || index > 3) {
    throw new StorageError('invalid', `Invalid channel index "${raw}"`);
  }
  return index;
}

/** Maps an uploaded image's `Content-Type` to the extension it is stored under. */
export function extFromContentType(contentType: string | undefined): string {
  const ext = extFromMime(contentType);
  if (!ext) {
    throw new StorageError('invalid', `Unsupported image type "${contentType ?? 'unknown'}"`);
  }
  return ext;
}

/** A required string field on a JSON request body. */
export function stringBody(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new StorageError('invalid', `"${name}" must be a non-empty string`);
  }
  return value;
}

/** Positive integer query param, e.g. `?width=512`. */
export function intQuery(req: Request, name: string): number {
  const raw = req.query[name];
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new StorageError('invalid', `Query parameter "${name}" must be a positive number`);
  }
  return Math.round(value);
}
