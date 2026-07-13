import { Injectable, inject } from '@angular/core';

import type { ThumbnailMeta } from '../../shared/model';
import { mimeFromExt } from '../../shared/validate';
import { API_BASE_URL } from './api-base-url';
import { DesktopPlatform } from './desktop-platform';

/**
 * Turns a shader's `ThumbnailMeta` into a URL the library can put in an `<img>`.
 *
 * The same split as `TextureAssets`: on the web a plain `GET` URL the browser
 * caches itself, on desktop the bytes come over IPC once per capture and are
 * wrapped in a blob URL. `thumbnail.updatedAt` is what makes a fresh capture
 * a different URL, so a re-saved shader never shows its old preview.
 */
@Injectable({ providedIn: 'root' })
export class ThumbnailAssets {
  private readonly desktop = inject(DesktopPlatform);
  private readonly baseUrl = inject(API_BASE_URL);

  private readonly blobUrls = new Map<string, string>();
  private readonly pending = new Map<string, Promise<string | null>>();

  /**
   * The preview's URL on the web, where it is a pure function of the listing —
   * no fetch, no state. That matters for more than brevity: the library is
   * server-rendered, so an `<img>` whose `src` needed a round trip would be
   * absent from the server's HTML and present on the client's first render,
   * and hydration would reject the mismatch.
   *
   * `null` on desktop, which has no HTTP server for shaders — use `resolve`.
   */
  url(shaderId: string, meta: ThumbnailMeta | null): string | null {
    if (!meta || this.desktop.available) return null;

    const bust = encodeURIComponent(meta.updatedAt);
    return `${this.baseUrl}/api/shaders/${shaderId}/thumbnail?v=${bust}`;
  }

  /**
   * The preview's URL on desktop, where the bytes have to come over IPC and be
   * wrapped in a blob URL. Cached per capture; there is no SSR here, so the
   * round trip is free to be asynchronous.
   */
  resolve(shaderId: string, meta: ThumbnailMeta | null): Promise<string | null> {
    if (!meta || !this.desktop.available) return Promise.resolve(null);

    const cacheKey = `${shaderId}:${meta.updatedAt}`;
    const cached = this.blobUrls.get(cacheKey);
    if (cached) return Promise.resolve(cached);

    const pending = this.pending.get(cacheKey);
    if (pending) return pending;

    const promise = this.loadBlobUrl(shaderId, cacheKey).finally(() => {
      this.pending.delete(cacheKey);
    });
    this.pending.set(cacheKey, promise);
    return promise;
  }

  private async loadBlobUrl(shaderId: string, cacheKey: string): Promise<string | null> {
    const thumbnail = await this.desktop.readThumbnail(shaderId);
    if (!thumbnail) return null;

    const url = URL.createObjectURL(
      new Blob([thumbnail.bytes.slice()], { type: mimeFromExt(thumbnail.ext) }),
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
