import { isPlatformBrowser } from '@angular/common';
import { Directive, ElementRef, PLATFORM_ID, DestroyRef, inject, input } from '@angular/core';

import { FontLoader } from '../../editor/google-fonts';

/**
 * Fetch a font when its row scrolls into view, and not one moment sooner.
 *
 * This is what keeps the picker honest about not downloading the whole shelf.
 * The catalogue is nearly thirty families; rendering each name in its own face
 * is the only way to choose between them, and doing that eagerly would mean
 * megabytes of woff2 for a list most people open once and scroll a third of.
 *
 * An IntersectionObserver rather than a hover or a focus handler, because the
 * font has to already be there when the row appears — asking for it once the
 * pointer arrives means every row previews in the fallback for a beat first.
 */
@Directive({
  selector: '[appFontPreview]',
})
export class FontPreview {
  /** The family to fetch once this element is visible. */
  readonly appFontPreview = input.required<string>();

  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly fonts = inject(FontLoader);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  constructor() {
    if (!this.isBrowser) return;

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;

      void this.fonts.load(this.appFontPreview());
      // One row, one fetch. Nothing changes on a second sighting.
      observer.disconnect();
    });

    observer.observe(this.host.nativeElement);
    this.destroyRef.onDestroy(() => observer.disconnect());
  }
}
