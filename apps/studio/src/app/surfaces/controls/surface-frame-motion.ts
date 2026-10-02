/**
 * Reduced-motion-aware host class bindings for contained surface frames.
 *
 * CSS transitions run only when not dragging and when the user has not
 * requested reduced motion. The ReducedMotion service is SSR-safe (false on
 * server / first paint).
 */

import { Directive, computed, inject, input } from '@angular/core';

import { ReducedMotion } from '../../prefs/reduced-motion';

@Directive({
  selector: '[surfaceFrameMotion]',
  host: {
    '[class.surface-frame--dragging]': 'dragging()',
    '[class.surface-frame--animating]': 'animating()',
  },
})
export class SurfaceFrameMotionDirective {
  private readonly reducedMotion = inject(ReducedMotion);

  readonly dragging = input(false);

  protected readonly animating = computed(() => !this.dragging() && !this.reducedMotion.enabled());
}
