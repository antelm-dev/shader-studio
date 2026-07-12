import { isPlatformBrowser } from '@angular/common';
import { DOCUMENT, Injectable, PLATFORM_ID, inject, signal } from '@angular/core';

import { isValidFontFamily } from '../core/editor-prefs';

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

export interface FontChoice {
  /** The family name, exactly as Google spells it. */
  family: string;
  /** The weights Google actually serves. Asking for one it does not have 400s. */
  weights: readonly number[];
  /** Whether the face carries programming ligatures (`=>`, `!==`, `->`). */
  ligatures: boolean;
  /** Shown under the name in the picker. */
  note: string;
}

/**
 * The one entry that is not a Google font: whatever the machine calls its
 * monospace. Always available, never fetched, and the honest choice for anyone
 * who has already installed the font they want to code in.
 */
export const SYSTEM_FONT = 'System monospace';

export const FONT_CATALOGUE: readonly FontChoice[] = [
  { family: SYSTEM_FONT, weights: [300, 400, 500, 600, 700], ligatures: false, note: 'Whatever this machine uses for code' },
  { family: 'JetBrains Mono', weights: [300, 400, 500, 600, 700], ligatures: true, note: 'Tall x-height, made for long sessions' },
  { family: 'Fira Code', weights: [300, 400, 500, 600, 700], ligatures: true, note: 'The font that popularised code ligatures' },
  { family: 'Victor Mono', weights: [300, 400, 500, 600, 700], ligatures: true, note: 'Cursive italics, semi-connected ligatures' },
  { family: 'Source Code Pro', weights: [300, 400, 500, 600, 700], ligatures: false, note: 'Adobe’s workhorse, unfussy and legible' },
  { family: 'IBM Plex Mono', weights: [300, 400, 500, 600, 700], ligatures: false, note: 'Warm and slightly humanist' },
  { family: 'Roboto Mono', weights: [300, 400, 500, 600, 700], ligatures: false, note: 'Neutral, familiar, hard to dislike' },
  { family: 'Inconsolata', weights: [300, 400, 500, 600, 700], ligatures: false, note: 'Narrow, fits a lot of GLSL on a line' },
  { family: 'Noto Sans Mono', weights: [300, 400, 500, 600, 700], ligatures: false, note: 'Enormous character coverage' },
  { family: 'Geist Mono', weights: [300, 400, 500, 600, 700], ligatures: false, note: 'Crisp and geometric' },
  { family: 'Red Hat Mono', weights: [300, 400, 500, 600, 700], ligatures: false, note: 'Open apertures, low contrast' },
  { family: 'Spline Sans Mono', weights: [300, 400, 500, 600, 700], ligatures: false, note: 'Rounded terminals, gentle on the eye' },
  { family: 'Azeret Mono', weights: [300, 400, 500, 600, 700], ligatures: false, note: 'Sturdy and squared-off' },
  { family: 'Martian Mono', weights: [300, 400, 500, 600, 700], ligatures: false, note: 'Wide and deliberate' },
  { family: 'Overpass Mono', weights: [300, 400, 500, 600, 700], ligatures: false, note: 'Based on US highway signage' },
  { family: 'Reddit Mono', weights: [300, 400, 500, 600, 700], ligatures: false, note: 'Compact, quietly modern' },
  { family: 'Chivo Mono', weights: [300, 400, 500, 600, 700], ligatures: false, note: 'Grotesque bones, plenty of weight' },
  { family: 'DM Mono', weights: [300, 400, 500], ligatures: false, note: 'Light and airy; no bold' },
  { family: 'Sometype Mono', weights: [400, 500, 600, 700], ligatures: false, note: 'Typewriter warmth, screen legibility' },
  { family: 'Space Mono', weights: [400, 700], ligatures: false, note: 'Quirky, characterful, not for everyone' },
  { family: 'Ubuntu Mono', weights: [400, 700], ligatures: false, note: 'Small on the page; set it a size up' },
  { family: 'Cousine', weights: [400, 700], ligatures: false, note: 'Metric-compatible with Courier New' },
  { family: 'Anonymous Pro', weights: [400, 700], ligatures: false, note: 'Designed for the coding of ambiguities' },
  { family: 'Courier Prime', weights: [400, 700], ligatures: false, note: 'Courier, redrawn to be readable' },
  { family: 'Nanum Gothic Coding', weights: [400, 700], ligatures: false, note: 'Latin plus full Hangul' },
  { family: 'Share Tech Mono', weights: [400], ligatures: false, note: 'Techy and narrow; one weight only' },
  { family: 'PT Mono', weights: [400], ligatures: false, note: 'Made for forms and tables' },
  { family: 'Fragment Mono', weights: [400], ligatures: false, note: 'Helvetica’s monospaced cousin' },
];

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
