import { Component, ElementRef, inject, input, output, signal } from '@angular/core';

/**
 * A vertical separator that resizes the panel beside it.
 *
 * Pointer capture rather than the CDK, for the same reason `EditorShell` does
 * it by hand: a gesture that begins on a separator must be captured *there* and
 * never reach what is behind it — the shader canvas would start swallowing the
 * drag as a ripple, and Monaco would start selecting code.
 *
 * The two outputs are the whole point of the design. `preview` fires on every
 * pointermove and is meant for a local signal; `commit` fires once, when the
 * user lets go, and is meant for `Preferences`. Patching preferences on every
 * move would serialise the entire preference object to `localStorage` sixty
 * times a second for a value that is only interesting once the gesture ends.
 */

/** How far the arrow keys drag the separator, and how far with Shift. */
const NUDGE = 16;
const NUDGE_FAST = 64;

@Component({
  selector: 'app-resize-handle',
  template: '',
  styles: `
    :host {
      position: absolute;
      top: 0;
      bottom: 0;
      z-index: 4;
      width: 10px;
      cursor: ew-resize;
      /* Transparent, but a real target: the difference between resizing a panel
         and hunting for its edge. */
      background: transparent;
      touch-action: none;
    }

    /* The line only appears once you are on it — the chrome is quiet by default,
       because the shader behind it is the point of the app. */
    :host::after {
      content: '';
      position: absolute;
      inset-block: 0;
      inset-inline-start: 50%;
      width: 2px;
      translate: -50%;
      background: transparent;
      transition: background 120ms ease;
    }

    :host(:hover)::after,
    :host(.dragging)::after {
      background: var(--mat-sys-primary);
    }

    :host(:focus-visible) {
      outline: 2px solid var(--mat-sys-primary);
      outline-offset: -2px;
    }

    @media (prefers-reduced-motion: reduce) {
      :host::after {
        transition: none;
      }
    }
  `,
  host: {
    role: 'separator',
    tabindex: '0',
    'aria-orientation': 'vertical',
    '[attr.aria-label]': 'label()',
    '[attr.aria-valuenow]': 'value()',
    '[attr.aria-valuemin]': 'min()',
    '[attr.aria-valuemax]': 'max()',
    '[class.dragging]': 'dragging()',
    '(pointerdown)': 'onPointerDown($event)',
    '(keydown)': 'onKeydown($event)',
    '(dblclick)': 'commit.emit(clamp(defaultValue()))',
  },
})
export class ResizeHandle {
  /** The width being dragged, in pixels. */
  readonly value = input.required<number>();
  readonly min = input.required<number>();
  readonly max = input.required<number>();
  readonly label = input.required<string>();

  /** What a double-click snaps back to. */
  readonly defaultValue = input.required<number>();

  /**
   * Which way the pointer has to travel to make the panel wider: `e` for a panel
   * whose separator is on its right (the browser), `w` for one whose separator
   * is on its left (the inspector).
   */
  readonly grow = input<'e' | 'w'>('e');

  /** Fires throughout the gesture. Drive a local signal with it, not storage. */
  readonly preview = output<number>();

  /** Fires once the gesture ends, or on a keyboard nudge. Safe to persist. */
  readonly commit = output<number>();

  protected readonly dragging = signal(false);

  private readonly host = inject(ElementRef<HTMLElement>);

  protected onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const host = this.host.nativeElement;
    host.setPointerCapture?.(event.pointerId);

    const originX = event.clientX;
    const start = this.value();
    const widthAt = (clientX: number): number =>
      this.clamp(start + this.sign() * (clientX - originX));

    this.dragging.set(true);

    const move = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== event.pointerId) return;
      this.preview.emit(widthAt(moveEvent.clientX));
    };

    const end = (endEvent: PointerEvent): void => {
      if (endEvent.pointerId !== event.pointerId) return;
      host.releasePointerCapture?.(endEvent.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      this.dragging.set(false);
      this.commit.emit(widthAt(endEvent.clientX));
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  /**
   * A separator you can only reach with a mouse is a feature half the users do
   * not have. Left and right pull it; Home and End take it to its limits.
   */
  protected onKeydown(event: KeyboardEvent): void {
    const step = event.shiftKey ? NUDGE_FAST : NUDGE;

    const next: Record<string, number> = {
      ArrowLeft: this.value() - this.sign() * step,
      ArrowRight: this.value() + this.sign() * step,
      Home: this.min(),
      End: this.max(),
    };

    const value = next[event.key];
    if (value === undefined) return;

    event.preventDefault();
    this.commit.emit(this.clamp(value));
  }

  protected clamp(value: number): number {
    return Math.round(Math.min(Math.max(value, this.min()), this.max()));
  }

  private sign(): number {
    return this.grow() === 'e' ? 1 : -1;
  }
}
