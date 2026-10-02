import { isPlatformBrowser } from '@angular/common';
import {
  DestroyRef,
  Directive,
  ElementRef,
  PLATFORM_ID,
  afterNextRender,
  inject,
} from '@angular/core';

import { SurfaceLayoutService } from '../../surfaces/surface-layout';

/**
 * Marks the region a windowed preview lives in, and keeps its measurements up to
 * date.
 */
@Directive({ selector: '[appPreviewStage]' })
export class PreviewStage {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly layout = inject(SurfaceLayoutService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  constructor() {
    afterNextRender(() => {
      if (!this.isBrowser) return;

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
    this.layout.setPreviewWorkspace({ x, y, width, height });
  }
}
