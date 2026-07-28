/**
 * Eight-edge floating resize grips + optional single dock free-edge separator.
 *
 * Reuses the visual language of `app-resize-handles` but lives under the
 * surfaces module so Agent 06 can adopt without coupling to editor/preview
 * shells. Keyboard events bubble as outputs with accurate separator ARIA.
 */

import { Component, computed, input, output } from '@angular/core';

import { RESIZE_EDGES, type ResizeEdge } from '@shader-studio/shared/geometry';
import type { DockSide } from '@shader-studio/shared/surfaces';

import {
  dockResizeEdge,
  dockSeparatorOrientation,
  floatingEdgeAriaOrientation,
} from '../surface-keyboard';

export interface SurfaceResizePointer {
  readonly event: PointerEvent;
  readonly edge: ResizeEdge;
}

export interface SurfaceResizeKey {
  readonly event: KeyboardEvent;
  readonly edge: ResizeEdge;
}

@Component({
  selector: 'surface-resize-handles',
  template: `
    @if (mode() === 'floating') {
      @for (edge of edges; track edge) {
        <div
          class="handle handle-{{ edge }}"
          role="separator"
          tabindex="0"
          [attr.aria-orientation]="orientation(edge)"
          [attr.aria-label]="label()(edge)"
          (pointerdown)="pointerDown.emit({ event: $event, edge })"
          (keydown)="keyDown.emit({ event: $event, edge })"
        ></div>
      }
    }

    @if (mode() === 'docked' && dockSide(); as side) {
      <div
        class="handle handle-dock handle-{{ freeEdge() }}"
        role="separator"
        tabindex="0"
        [attr.aria-orientation]="dockOrientation()"
        [attr.aria-label]="dockLabel()"
        [attr.aria-valuenow]="dockValue()"
        [attr.aria-valuemin]="dockMin()"
        [attr.aria-valuemax]="dockMax()"
        (pointerdown)="pointerDown.emit({ event: $event, edge: freeEdge()! })"
        (keydown)="keyDown.emit({ event: $event, edge: freeEdge()! })"
      ></div>
    }
  `,
  styles: `
    :host {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }

    .handle {
      position: absolute;
      z-index: 1;
      pointer-events: auto;
      background: transparent;
      touch-action: none;
    }

    .handle:focus-visible {
      outline: 2px solid var(--mat-sys-primary);
      outline-offset: -2px;
      background: color-mix(in srgb, var(--mat-sys-primary) 24%, transparent);
    }

    .handle-n,
    .handle-s {
      left: 0;
      right: 0;
      height: 6px;
      cursor: ns-resize;
    }

    .handle-e,
    .handle-w {
      top: 0;
      bottom: 0;
      width: 6px;
      cursor: ew-resize;
    }

    .handle-n {
      top: var(--surface-resize-handle-top-offset, 0px);
    }

    .handle-s {
      bottom: 0;
    }

    .handle-e {
      right: 0;
    }

    .handle-w {
      left: 0;
    }

    .handle-ne,
    .handle-nw,
    .handle-se,
    .handle-sw {
      width: 14px;
      height: 14px;
      z-index: 2;
    }

    .handle-ne {
      top: 0;
      right: 0;
      cursor: nesw-resize;
    }

    .handle-nw {
      top: 0;
      left: 0;
      cursor: nwse-resize;
    }

    .handle-se {
      bottom: 0;
      right: 0;
      cursor: nwse-resize;
    }

    .handle-sw {
      bottom: 0;
      left: 0;
      cursor: nesw-resize;
    }

    /* Dock free-edge: larger hit target than floating grips. */
    .handle-dock.handle-n,
    .handle-dock.handle-s {
      height: 10px;
    }

    .handle-dock.handle-e,
    .handle-dock.handle-w {
      width: 10px;
    }
  `,
})
export class SurfaceResizeHandles {
  protected readonly edges = RESIZE_EDGES;

  /** `'floating'` → eight edges; `'docked'` → free edge only; otherwise none. */
  readonly mode = input<'floating' | 'docked' | 'none'>('floating');

  readonly dockSide = input<DockSide | null>(null);
  readonly dockValue = input(0);
  readonly dockMin = input(0);
  readonly dockMax = input(0);
  readonly dockLabel = input('Resize panel');

  /** Accessible name for a floating edge grip. */
  readonly label = input.required<(edge: ResizeEdge) => string>();

  readonly pointerDown = output<SurfaceResizePointer>();
  readonly keyDown = output<SurfaceResizeKey>();

  protected readonly freeEdge = computed(() => {
    const side = this.dockSide();
    return side ? dockResizeEdge(side) : null;
  });

  protected readonly dockOrientation = computed(() => {
    const side = this.dockSide();
    return side ? dockSeparatorOrientation(side) : 'vertical';
  });

  protected orientation(edge: ResizeEdge): 'horizontal' | 'vertical' {
    return floatingEdgeAriaOrientation(edge);
  }
}
