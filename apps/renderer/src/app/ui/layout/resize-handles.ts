import { Component, input, output } from '@angular/core';

import { RESIZE_EDGES, type ResizeEdge } from '@shader-studio/shared/geometry';

/**
 * The eight grips a floating window is pulled from — one component instead of
 * the identical loop and CSS the editor and the preview window used to carry
 * separately. Only floating windows use it: a docked panel has one edge that
 * means anything (see `EditorShell`'s own handle for that), and a maximized one
 * has none.
 *
 * The pointer-capture and keyboard-nudge arithmetic stay with the caller, which
 * is the only one that knows what rect it is resizing; this only draws the grips
 * and reports which edge and event they saw.
 */
@Component({
  selector: 'app-resize-handles',
  template: `
    @for (edge of edges; track edge) {
      <div
        class="handle handle-{{ edge }}"
        role="separator"
        tabindex="0"
        [attr.aria-orientation]="edge === 'n' || edge === 's' ? 'horizontal' : 'vertical'"
        [attr.aria-label]="label()(edge)"
        (pointerdown)="pointerDown.emit({ event: $event, edge })"
        (keydown)="keyDown.emit({ event: $event, edge })"
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
      /* Transparent, but a real target: 6px of grab area is the difference
         between resizing a window and hunting for its edge. */
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
      top: var(--resize-handle-top-offset, 0px);
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
  `,
})
export class ResizeHandles {
  protected readonly edges = RESIZE_EDGES;

  /** The accessible name for a given edge's grip. */
  readonly label = input.required<(edge: ResizeEdge) => string>();

  readonly pointerDown = output<{ event: PointerEvent; edge: ResizeEdge }>();
  readonly keyDown = output<{ event: KeyboardEvent; edge: ResizeEdge }>();
}
