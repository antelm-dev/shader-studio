/**
 * Title-bar drag / double-click seam.
 *
 * Content wrappers keep their own title markup and project controls into the
 * bar; this directive only owns pointer drag-start filtering and maximize
 * toggle on double-click — matching editor/preview shell behavior.
 */

import { Directive, input, output } from '@angular/core';

@Directive({
  selector: '[surfaceTitleBar]',
  host: {
    class: 'surface-title-bar',
    '[class.surface-title-bar--draggable]': 'dragEnabled()',
    '(pointerdown)': 'onPointerDown($event)',
    '(dblclick)': 'onDoubleClick($event)',
  },
})
export class SurfaceTitleBarDirective {
  /** When false, pointerdown is ignored (maximized / docked). */
  readonly dragEnabled = input(false);

  /** Emits when a drag should begin (left button, not on interactive chrome). */
  readonly dragStart = output<PointerEvent>();

  /** Double-click maximize/restore toggle — wrappers decide the command. */
  readonly toggleMaximize = output<void>();

  protected onPointerDown(event: PointerEvent): void {
    if (!this.dragEnabled() || event.button !== 0) return;
    if (this.isInteractiveTarget(event.target)) return;
    this.dragStart.emit(event);
  }

  protected onDoubleClick(event: MouseEvent): void {
    if (this.isInteractiveTarget(event.target)) return;
    this.toggleMaximize.emit();
  }

  private isInteractiveTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest('button, a, input, textarea, select, [role="menuitem"]'));
  }
}
