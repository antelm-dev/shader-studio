import { isPlatformBrowser } from '@angular/common';
import {
  DestroyRef,
  Directive,
  ElementRef,
  PLATFORM_ID,
  afterNextRender,
  inject,
} from '@angular/core';

import { PreviewWindow } from '../rendering/preview-window';

/**
 * Marks the region a windowed preview lives in, and keeps its measurements up to
 * date.
 *
 * The preview's frame is positioned against the *viewport* — it is the page's
 * background before it is anything else, and a background cannot be a child of
 * the chrome drawn on top of it. Its geometry, though, is remembered against the
 * *workspace*: the stage is what "maximized" fills and what a floating window is
 * clamped to, and it is neither the window nor the screen. It shrinks when the
 * shader browser opens, when the inspector appears, when the editor docks.
 *
 * So the stage is measured where it is, and the origin it reports is what the
 * shell converts between the two coordinate systems with.
 */
@Directive({ selector: '[appPreviewStage]' })
export class PreviewStage {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly preview = inject(PreviewWindow);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  constructor() {
    afterNextRender(() => {
      if (!this.isBrowser) return;

      // The observer catches everything that changes the stage's *size* — the
      // drawer, the inspector, the docked editor, the window. `resize` catches
      // the one thing it does not: a viewport that changed height without the
      // stage's own box changing, which moves the origin under a fixed frame.
      const observer = new ResizeObserver(() => this.measure());
      observer.observe(this.host.nativeElement);

      const onViewportResize = () => this.measure();
      window.addEventListener('resize', onViewportResize);

      this.destroyRef.onDestroy(() => {
        observer.disconnect();
        window.removeEventListener('resize', onViewportResize);
      });

      this.measure();
    });
  }

  private measure(): void {
    const { x, y, width, height } = this.host.nativeElement.getBoundingClientRect();
    this.preview.setWorkspace({ x, y, width, height });
  }
}
