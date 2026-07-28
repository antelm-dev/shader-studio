/**
 * Pointer drag/resize orchestration with live preview state.
 *
 * Commits only when the gesture ends — never on every pointermove. Uses the
 * shared PointerGesture capture lifecycle so Monaco/canvas content cannot steal
 * the drag mid-gesture.
 *
 * Safe to construct during SSR: listeners attach only when `begin` runs with a
 * real PointerEvent (browser).
 */

import { signal } from '@angular/core';

import {
  containPoint,
  resizeRect,
  type Point,
  type Rect,
  type ResizeEdge,
  type Size,
} from '@shader-studio/shared/geometry';
import {
  SURFACE_MIN_SIZES,
  clampDockSize,
  clampFloatingRect,
  type DockSide,
  type SurfaceKind,
} from '@shader-studio/shared/surfaces';

import { PointerGesture } from '../ui/layout/pointer-gesture';
import { SURFACE_MINIMIZED_CHROME } from './surface-frame';

export type SurfaceGestureKind =
  | 'move-floating'
  | 'move-minimized'
  | 'resize-floating'
  | 'resize-docked';

interface GestureOrigin {
  readonly kind: SurfaceGestureKind;
  readonly rect: Rect;
  readonly point: Point;
  readonly dockSize: number;
  readonly dockSide: DockSide | null;
  readonly edge: ResizeEdge | null;
  readonly surfaceKind: SurfaceKind;
  readonly viewport: Size;
  readonly minimizedSize: Size;
}

export interface SurfaceGestureCommit {
  readonly kind: SurfaceGestureKind;
  readonly rect?: Rect;
  readonly point?: Point;
  readonly dockSize?: number;
}

/**
 * Per-surface (or per-host) gesture controller. Content wrappers own one
 * instance and bind title-bar / resize-handle events to it.
 */
export class SurfaceGeometryGesture {
  private readonly pointer = new PointerGesture();
  private readonly liveRectSignal = signal<Rect | null>(null);
  private readonly livePointSignal = signal<Point | null>(null);
  private readonly liveDockSizeSignal = signal<number | null>(null);

  readonly dragging = this.pointer.dragging;
  readonly liveRect = this.liveRectSignal.asReadonly();
  readonly livePoint = this.livePointSignal.asReadonly();
  readonly liveDockSize = this.liveDockSizeSignal.asReadonly();

  /**
   * Begin a pointer gesture. Captures the pointer on `target` so the drag
   * survives crossing Monaco/canvas.
   */
  begin(
    event: PointerEvent,
    target: HTMLElement | null,
    origin: {
      readonly gesture: SurfaceGestureKind;
      readonly surfaceKind: SurfaceKind;
      readonly viewport: Size;
      readonly rect?: Rect;
      readonly point?: Point;
      readonly dockSize?: number;
      readonly dockSide?: DockSide;
      readonly edge?: ResizeEdge;
      readonly minimizedSize?: Size;
    },
    onCommit: (result: SurfaceGestureCommit) => void,
  ): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const state: GestureOrigin = {
      kind: origin.gesture,
      rect: origin.rect ?? { x: 0, y: 0, width: 320, height: 240 },
      point: origin.point ?? { x: 24, y: 24 },
      dockSize: origin.dockSize ?? 300,
      dockSide: origin.dockSide ?? null,
      edge: origin.edge ?? null,
      surfaceKind: origin.surfaceKind,
      viewport: origin.viewport,
      minimizedSize: origin.minimizedSize ?? SURFACE_MINIMIZED_CHROME,
    };

    this.pointer.begin(event, target, {
      onMove: (dx, dy) => this.apply(state, dx, dy),
      onCommit: (dx, dy) => {
        this.apply(state, dx, dy);
        const commit = this.snapshot(state.kind);
        this.clearLive();
        if (commit) onCommit(commit);
      },
    });
  }

  /** Clear live preview without committing (e.g. host destroyed mid-gesture). */
  cancel(): void {
    this.clearLive();
  }

  private apply(origin: GestureOrigin, dx: number, dy: number): void {
    switch (origin.kind) {
      case 'move-floating':
        this.liveRectSignal.set(
          clampFloatingRect(
            origin.surfaceKind,
            { ...origin.rect, x: origin.rect.x + dx, y: origin.rect.y + dy },
            origin.viewport,
          ),
        );
        return;
      case 'move-minimized':
        this.livePointSignal.set(
          containPoint(
            { x: origin.point.x + dx, y: origin.point.y + dy },
            origin.viewport,
            origin.minimizedSize,
          ),
        );
        return;
      case 'resize-floating': {
        if (!origin.edge) return;
        const min = SURFACE_MIN_SIZES[origin.surfaceKind].floating;
        this.liveRectSignal.set(
          clampFloatingRect(
            origin.surfaceKind,
            resizeRect(origin.rect, origin.edge, dx, dy, min),
            origin.viewport,
          ),
        );
        return;
      }
      case 'resize-docked': {
        if (!origin.dockSide) return;
        let next = origin.dockSize;
        const side = origin.dockSide;
        if (side === 'bottom') next = origin.dockSize - dy;
        else if (side === 'top') next = origin.dockSize + dy;
        else if (side === 'left') next = origin.dockSize + dx;
        else next = origin.dockSize - dx;

        const clamped = clampDockSize(origin.surfaceKind, next);
        const viewport = origin.viewport;
        if (viewport.width > 0 && viewport.height > 0) {
          const maxSpan =
            side === 'bottom' || side === 'top' ? viewport.height * 0.75 : viewport.width * 0.75;
          const limits = SURFACE_MIN_SIZES[origin.surfaceKind].dock;
          const floor = limits.min > 0 ? limits.min : 120;
          this.liveDockSizeSignal.set(Math.round(Math.min(Math.max(clamped, floor), maxSpan)));
        } else {
          this.liveDockSizeSignal.set(clamped);
        }
        return;
      }
    }
  }

  private snapshot(kind: SurfaceGestureKind): SurfaceGestureCommit | null {
    if (kind === 'move-floating' || kind === 'resize-floating') {
      const rect = this.liveRectSignal();
      return rect ? { kind, rect } : null;
    }
    if (kind === 'move-minimized') {
      const point = this.livePointSignal();
      return point ? { kind, point } : null;
    }
    const dockSize = this.liveDockSizeSignal();
    return dockSize !== null ? { kind, dockSize } : null;
  }

  private clearLive(): void {
    this.liveRectSignal.set(null);
    this.livePointSignal.set(null);
    this.liveDockSizeSignal.set(null);
  }
}
