import type { Response } from 'express';

import { StorageError } from '@shadergrove/backend/library';
import { textureAssetKey, type AssetKey } from '@shadergrove/backend/persistence';
import { mimeFromExt } from '@shadergrove/shared/validate';

/** A channel texture's asset key; anything but 0–3 is the same 404 as an unknown publication. */
export function textureKey(raw: string): AssetKey {
  if (!/^[0-3]$/.test(raw)) throw new StorageError('not_found', 'Publication was not found');
  return textureAssetKey(Number(raw));
}

/** Never cached: a publication can be hidden at any moment. */
export function sendImage(response: Response, image: { bytes: Uint8Array; ext: string }): void {
  response
    .setHeader('Content-Type', mimeFromExt(image.ext))
    .setHeader('Cache-Control', 'no-store')
    .send(Buffer.from(image.bytes));
}
