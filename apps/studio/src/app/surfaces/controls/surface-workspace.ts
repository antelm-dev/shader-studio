/**
 * Measures the workspace host and feeds SurfaceRegistry.setViewport.
 *
 * Attach to the stage/workspace element Agent 06 uses as the containment box.
 * Uses ResizeObserver only in the browser — SSR leaves viewport at 0×0 so
 * domain clamps pass geometry through until the first client measure.
 */

import { isPlatformBrowser } from '@angular/common';
import {
  DestroyRef,
  Directive,
  ElementRef,
  PLATFORM_ID,
  afterNextRender,
  inject,
} from '@angular/core';

import { SurfaceRegistry } from '../surface-registry';

@Directive({
  selector: '[surfaceWorkspace]',
})
export class SurfaceWorkspaceDirective {
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly registry = inject(SurfaceRegistry);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  constructor() {
    afterNextRender(() => this.observe());
  }

  private observe(): void {
    if (!this.isBrowser) return;

    const element = this.host.nativeElement;
    const measure = (): void => {
      const { width, height } = element.getBoundingClientRect();
      this.registry.setViewport({ width, height });
    };

    measure();

    const observer = new ResizeObserver(() => measure());
    observer.observe(element);
    this.destroyRef.onDestroy(() => observer.disconnect());
  }
}
