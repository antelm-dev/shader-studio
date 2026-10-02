import { signal } from '@angular/core';

interface PointerGestureHandlers {
  /** Called on every pointermove, with the movement since the gesture began. */
  onMove(dx: number, dy: number): void;
  /** Called once, when the pointer is released or the gesture is cancelled. */
  onCommit(dx: number, dy: number): void;
}

/**
 * The pointer-capture lifecycle every draggable handle in the workspace needs:
 * capture the pointer, track it until release, and call back with how far it has
 * moved. A title bar, a resize grip and a docked panel's edge all want exactly
 * this and differ only in what they do with `dx`/`dy` — that arithmetic stays
 * with the caller, which is the only one that knows what it is dragging.
 */
export class PointerGesture {
  private readonly pointerId = signal<number | null>(null);

  readonly dragging = signal(false);

  begin(event: PointerEvent, target: HTMLElement | null, handlers: PointerGestureHandlers): void {
    const pointerId = event.pointerId;
    const originX = event.clientX;
    const originY = event.clientY;

    target?.setPointerCapture?.(pointerId);
    this.pointerId.set(pointerId);
    this.dragging.set(true);

    const move = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== pointerId) return;
      handlers.onMove(moveEvent.clientX - originX, moveEvent.clientY - originY);
    };

    const end = (endEvent: PointerEvent): void => {
      if (endEvent.pointerId !== pointerId) return;
      target?.releasePointerCapture?.(pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      this.pointerId.set(null);
      this.dragging.set(false);
      handlers.onCommit(endEvent.clientX - originX, endEvent.clientY - originY);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }
}
