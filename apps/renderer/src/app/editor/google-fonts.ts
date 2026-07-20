import { isPlatformBrowser } from '@angular/common';
import { DOCUMENT, Injectable, PLATFORM_ID, inject, signal } from '@angular/core';

import { isValidFontFamily } from '@shader-studio/shared/editor-prefs';

import { FONT_CATALOGUE, SYSTEM_FONT, type FontChoice } from './font-catalogue';

export { FONT_CATALOGUE, SYSTEM_FONT, type FontChoice } from './font-catalogue';

/**
 * A curated shelf of monospaced Google Fonts, and a loader that fetches them one
 * at a time.
 *
 * Curated, not complete: Google serves some 1,800 families, of which a few dozen
 * are usable for code. Offering all of them would be a search box over a haystack.
 *
 * *One at a time* matters more than it sounds. The obvious implementation asks
 * Google for every family in one stylesheet so that the picker can render each
 * name in its own face — around 2 MB of woff2 for a list most people scroll past
 * once. Instead nothing is fetched until something needs it: the family in use at
 * startup, and thereafter whichever rows the picker actually scrolls into view.
 *
 * A font that fails to arrive is not an error the user has to act on. The stack
 * in `FONT_FALLBACKS` is still monospaced and still readable, so a blocked CDN,
 * an offline machine or a strict CSP costs you the typeface and nothing else —
 * which is why every failure here ends in a signal, not an exception.
 */

export type FontStatus = 'idle' | 'loading' | 'loaded' | 'error';

/** Give up on a font that has not arrived by now, and keep the fallbacks. */
const LOAD_TIMEOUT_MS = 10_000;

export function findFont(family: string): FontChoice | undefined {
  return FONT_CATALOGUE.find((font) => font.family === family);
}

/**
 * The weight to use for a family that does not serve the one you asked for.
 *
 * Browsers will happily synthesise a missing bold by smearing the regular, which
 * looks exactly as bad as it sounds. Snapping to the nearest real weight gives a
 * face that was actually drawn.
 */
export function nearestWeight(family: string, weight: number): number {
  const weights = findFont(family)?.weights;
  if (!weights || weights.length === 0 || weights.includes(weight)) return weight;

  return weights.reduce((best, candidate) =>
    Math.abs(candidate - weight) < Math.abs(best - weight) ? candidate : best,
  );
}

@Injectable({ providedIn: 'root' })
export class FontLoader {
  private readonly document = inject(DOCUMENT);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** Status per family. A signal, so a picker row re-renders when its font lands. */
  private readonly statuses = signal<Readonly<Record<string, FontStatus>>>({});

  /** In-flight and settled loads, so asking twice does not fetch twice. */
  private readonly requests = new Map<string, Promise<FontStatus>>();

  statusOf(family: string): FontStatus {
    if (family === SYSTEM_FONT) return 'loaded';
    return this.statuses()[family] ?? 'idle';
  }

  /**
   * Fetch a family, if it is one we know about and have not fetched already.
   *
   * Resolves with the outcome rather than rejecting: every caller here treats a
   * missing font as a cosmetic disappointment, and none of them want a try/catch.
   */
  load(family: string): Promise<FontStatus> {
    if (!this.isBrowser || family === SYSTEM_FONT || !isValidFontFamily(family)) {
      return Promise.resolve('loaded');
    }
    if (!findFont(family)) return Promise.resolve('error');

    const existing = this.requests.get(family);
    if (existing) return existing;

    const request = this.fetch(family);
    this.requests.set(family, request);
    return request;
  }

  private async fetch(family: string): Promise<FontStatus> {
    this.setStatus(family, 'loading');

    try {
      await this.injectStylesheet(family);

      // The stylesheet only declares the faces. Nothing is fetched until
      // something asks for a glyph, and `document.fonts.load` is that ask —
      // without it a font "loads" and then renders as the fallback anyway.
      const weights = findFont(family)?.weights ?? [400];
      await Promise.all(
        weights.map((weight) => this.document.fonts.load(`${weight} 16px '${family}'`)),
      );

      // `fonts.load` resolves happily with an empty face list if the family is
      // unknown, so the outcome is whether the browser can now *check* for it.
      if (!this.document.fonts.check(`16px '${family}'`)) throw new Error('face never arrived');

      this.setStatus(family, 'loaded');
      return 'loaded';
    } catch {
      this.setStatus(family, 'error');
      // Forget the failure, so a font that failed while offline can be retried
      // once the picker asks for it again.
      this.requests.delete(family);
      return 'error';
    }
  }

  /**
   * Add the `<link>` for one family, and resolve when the browser says it has the
   * stylesheet — or reject, on error or after `LOAD_TIMEOUT_MS`. A CDN that never
   * answers must not leave a row spinning forever.
   */
  private injectStylesheet(family: string): Promise<void> {
    const id = `google-font-${family.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

    const existing = this.document.getElementById(id);
    if (existing) return Promise.resolve();

    const weights = findFont(family)?.weights ?? [400];
    const url = new URL('https://fonts.googleapis.com/css2');
    url.searchParams.set('family', `${family}:wght@${weights.join(';')}`);
    url.searchParams.set('display', 'swap');

    return new Promise<void>((resolve, reject) => {
      const link = this.document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      link.href = url.toString();

      const timer = setTimeout(() => {
        link.remove();
        reject(new Error(`timed out fetching ${family}`));
      }, LOAD_TIMEOUT_MS);

      link.addEventListener('load', () => {
        clearTimeout(timer);
        resolve();
      });
      link.addEventListener('error', () => {
        clearTimeout(timer);
        link.remove();
        reject(new Error(`failed to fetch ${family}`));
      });

      this.document.head.appendChild(link);
    });
  }

  private setStatus(family: string, status: FontStatus): void {
    this.statuses.update((current) => ({ ...current, [family]: status }));
  }
}
