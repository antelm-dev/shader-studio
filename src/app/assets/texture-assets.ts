import { Injectable, inject } from '@angular/core';

import type {
  TextureChannel,
  TextureFilterMode,
  TextureWrapMode,
} from '@shader-studio/shared/model';
import { mimeFromExt } from '@shader-studio/shared/validate';
import { API_BASE_URL } from '../api/api-base-url';
import { DesktopPlatform } from '../desktop/desktop-platform';

/** A channel resolved to something the renderer/preview can actually load from. */
export interface ResolvedChannel {
  url: string;
  wrap: TextureWrapMode;
  filter: TextureFilterMode;
  flipY: boolean;
}

/**
 * Turns a `TextureChannel`'s metadata into a loadable URL.
 *
 * On the web this is a plain `GET` URL — the browser handles caching. On
 * desktop there is no HTTP server for shaders, so the bytes travel over IPC
 * once per `(shader, channel, updatedAt)` and are wrapped in a blob URL,
 * cached for as long as that version is current.
 */
@Injectable({ providedIn: 'root' })
export class TextureAssets {
  private readonly desktop = inject(DesktopPlatform);
  private readonly baseUrl = inject(API_BASE_URL);

  private readonly blobUrls = new Map<string, string>();
  private readonly pending = new Map<string, Promise<string>>();

  /** Resolves a channel to a URL + its sampling settings, or `null` if nothing is assigned. */
  async resolve(
    shaderId: string,
    channel: number,
    meta: TextureChannel,
    updatedAt: string,
  ): Promise<ResolvedChannel | null> {
    if (meta.ext === null) return null;
    const url = await this.urlFor(shaderId, channel, meta.ext, updatedAt);
    return { url, wrap: meta.wrap, filter: meta.filter, flipY: meta.flipY };
  }

  private urlFor(
    shaderId: string,
    channel: number,
    ext: string,
    updatedAt: string,
  ): Promise<string> {
    if (!this.desktop.available) {
      const bust = encodeURIComponent(updatedAt);
      return Promise.resolve(
        `${this.baseUrl}/api/shaders/${shaderId}/textures/${channel}?v=${bust}`,
      );
    }

    const cacheKey = `${shaderId}:${channel}:${updatedAt}`;
    const cached = this.blobUrls.get(cacheKey);
    if (cached) return Promise.resolve(cached);

    const pending = this.pending.get(cacheKey);
    if (pending) return pending;

    const promise = this.loadBlobUrl(shaderId, channel, ext, cacheKey).finally(() => {
      this.pending.delete(cacheKey);
    });
    this.pending.set(cacheKey, promise);
    return promise;
  }

  private async loadBlobUrl(
    shaderId: string,
    channel: number,
    fallbackExt: string,
    cacheKey: string,
  ): Promise<string> {
    const texture = await this.desktop.readTexture(shaderId, channel);
    if (!texture) throw new Error(`Texture for channel ${channel} is missing on disk`);

    const url = URL.createObjectURL(
      new Blob([texture.bytes.slice()], { type: mimeFromExt(texture.ext || fallbackExt) }),
    );
    this.blobUrls.set(cacheKey, url);
    return url;
  }

  /** Revokes every cached blob URL belonging to a shader — call when it is removed or replaced. */
  releaseShader(shaderId: string): void {
    const prefix = `${shaderId}:`;
    for (const [key, url] of this.blobUrls) {
      if (!key.startsWith(prefix)) continue;
      URL.revokeObjectURL(url);
      this.blobUrls.delete(key);
    }
  }
}
