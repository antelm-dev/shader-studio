import { isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  PLATFORM_ID,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import { EDITOR_LIMITS, type Rect } from '../core/editor-prefs';
import { EditorWindow } from '../editor/editor-window';
import { EditorPanel } from './editor-panel';

/**
 * The editor's frame: where the panel sits, and how you move and size it.
 *
 * The single most important line in this file is the one that renders
 * `<app-editor-panel>`: there is exactly one, it is never inside a `@if`, and it
 * never moves in the DOM. Docking, detaching, maximizing and collapsing are all
 * *styling* of the frame around it. That is what preserves the buffers, the
 * cursor, the selection, the scroll offset, the open tab and the undo history
 * across every transition — not because we save and restore them, but because
 * nothing is ever torn down to need restoring.
 *
 * Dragging and resizing are done with pointer events and pointer capture rather
 * than with the CDK, for one reason: the frame contains a code editor. A gesture
 * that begins on a resize handle or on the title bar must be captured *there*
 * and never reach Monaco, or a drag near the edge of the window would start
 * selecting code instead of moving it.
 */

/** Which edges a resize gesture is pulling. */
type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

interface Gesture {
  pointerId: number;
  /** Pointer position when the gesture began, in client coordinates. */
  originX: number;
  originY: number;
  /** The rect (or docked height) as it was when the gesture began. */
  rect: Rect;
  height: number;
  edge: ResizeEdge | null;
}

/** How far the arrow keys move or resize the window, and how far with Shift. */
const NUDGE = 16;
const NUDGE_FAST = 64;

@Component({
  selector: 'app-editor-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EditorPanel],
  template: `
    <!-- The docked panel's top edge. A separator, so a keyboard can resize it. -->
    @if (mode() === 'docked') {
      <div
        class="handle handle-n"
        role="separator"
        tabindex="0"
        aria-orientation="horizontal"
        aria-label="Resize the editor panel. Use the up and down arrow keys."
        [attr.aria-valuenow]="editorWindow.dockedHeight()"
        [attr.aria-valuemin]="limits.dockedHeight.min"
        [attr.aria-valuemax]="limits.dockedHeight.max"
        (pointerdown)="startResize($event, 'n')"
        (keydown)="onHandleKeydown($event, 'n')"
      ></div>
    }

    <app-editor-panel
      #panel
      [collapsed]="mode() === 'minimized'"
      [dragEnabled]="mode() === 'floating'"
      (dragStart)="startDrag($event)"
    />

    <!-- Eight grips, so the window can be pulled from any edge or corner. Only
         when floating: a docked panel has one edge that means anything, and a
         maximized one has none. -->
    @if (mode() === 'floating') {
      @for (edge of edges; track edge) {
        <div
          class="handle handle-{{ edge }}"
          role="separator"
          tabindex="0"
          [attr.aria-orientation]="edge === 'n' || edge === 's' ? 'horizontal' : 'vertical'"
          [attr.aria-label]="resizeLabel(edge)"
          (pointerdown)="startResize($event, edge)"
          (keydown)="onHandleKeydown($event, edge)"
        ></div>
      }
    }
  `,
  styles: `
    :host {
      position: relative;
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow: visible;
      pointer-events: auto;
      border: 1px solid var(--mat-sys-outline-variant);
      background: color-mix(in srgb, var(--mat-sys-surface-container-lowest) 94%, transparent);
      backdrop-filter: blur(18px);
    }

    /* Only the geometry is animated, and only when the mode changes — never
       during a gesture, where a transition would make the window lag the pointer
       by exactly its own duration. */
    :host(.animating) {
      transition:
        height 180ms ease,
        width 180ms ease,
        inset 180ms ease;
    }

    @media (prefers-reduced-motion: reduce) {
      :host(.animating) {
        transition: none;
      }
    }

    /* --- Docked: a row of the workspace grid, above nothing. ------------- */

    :host(.docked),
    :host(.minimized) {
      grid-area: editor;
      border-width: 1px 0 0;
    }

    /* --- Maximized: the whole workspace. --------------------------------- */

    :host(.maximized) {
      position: absolute;
      inset: 0;
      z-index: 3;
      border-width: 1px 0 0;
    }

    /* --- Floating: a window over the shader. ----------------------------- */

    :host(.floating) {
      position: absolute;
      z-index: 3;
      overflow: hidden;
      border-radius: var(--mat-sys-corner-medium, 8px);
      box-shadow: var(--mat-sys-level4);
    }

    /* Squeezed to the toolbar. The shader behind it is the point of collapsing. */
    :host(.minimized) {
      height: auto;
    }

    /* --- Handles --------------------------------------------------------- */

    .handle {
      position: absolute;
      z-index: 1;
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
      top: -3px;
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

    /* The docked handle sits on the panel's own top border and has to be
       grabbable from just above it. */
    :host(.docked) .handle-n {
      height: 7px;
      top: -4px;
    }
  `,
  host: {
    '[class.docked]': 'mode() === "docked"',
    '[class.floating]': 'mode() === "floating"',
    '[class.maximized]': 'mode() === "maximized"',
    '[class.minimized]': 'mode() === "minimized"',
    '[class.dragging]': 'gesture() !== null',
    '[class.animating]': 'gesture() === null',
    '[style.height.px]': 'hostHeight()',
    '[style.left.px]': 'hostRect()?.x',
    '[style.top.px]': 'hostRect()?.y',
    '[style.width.px]': 'hostRect()?.width',
    role: 'region',
    'aria-label': 'Source editor',
  },
})
export class EditorShell {
  protected readonly editorWindow = inject(EditorWindow);
  protected readonly limits = EDITOR_LIMITS;

  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  private readonly panel = viewChild.required(EditorPanel);

  protected readonly edges: readonly ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

  protected readonly mode = this.editorWindow.mode;

  /**
   * The gesture in flight, if any.
   *
   * While it is set, the frame renders from `live` instead of from the store.
   * Committing every pointermove to `Preferences` would serialise the whole
   * preference object to `localStorage` sixty times a second, for a value that is
   * only interesting once the user lets go.
   */
  protected readonly gesture = signal<Gesture | null>(null);
  private readonly live = signal<Rect | null>(null);
  private readonly liveHeight = signal<number | null>(null);

  /** Position and width — floating only; the other modes are laid out by CSS. */
  protected readonly hostRect = computed<Rect | null>(() => {
    if (this.mode() !== 'floating') return null;
    return this.live() ?? this.editorWindow.floatingRect();
  });

  protected readonly hostHeight = computed<number | null>(() => {
    const mode = this.mode();
    if (mode === 'floating') return (this.live() ?? this.editorWindow.floatingRect()).height;
    if (mode === 'docked') return this.liveHeight() ?? this.editorWindow.dockedHeight();
    // Maximized fills its container and minimized shrinks to its toolbar; both
    // are better left to CSS than pinned to a number that could go stale.
    return null;
  });

  constructor() {
    afterNextRender(() => {
      this.observeWorkspace();
      // The persisted rect has never been checked against *this* viewport. Doing
      // it on the first frame is what recovers a window saved on a wider screen.
      this.measure();
    });

    // Any change of mode or size changes the box Monaco is living in, and Monaco
    // only re-measures what it can see. A tab that was hidden through the
    // transition would otherwise keep the old layout until you typed in it.
    effect(() => {
      this.mode();
      this.hostHeight();
      this.hostRect();
      untracked(() => this.scheduleRelayout());
    });
  }

  // --- Measuring ----------------------------------------------------------

  /**
   * Watch the workspace, not the window.
   *
   * The editor is positioned against its parent — the stage — which changes size
   * when the browser is resized, but also when the shader browser's drawer opens.
   * A floating window pinned to the right edge would be left hanging over the
   * drawer if we only listened for `window.resize`.
   */
  private observeWorkspace(): void {
    const workspace = this.host.nativeElement.parentElement;
    if (!this.isBrowser || !workspace) return;

    const observer = new ResizeObserver(() => this.measure());
    observer.observe(workspace);
    this.destroyRef.onDestroy(() => observer.disconnect());
  }

  private measure(): void {
    const workspace = this.host.nativeElement.parentElement;
    if (!workspace) return;

    const { width, height } = workspace.getBoundingClientRect();
    this.editorWindow.setViewport({ width, height });
  }

  private scheduleRelayout(): void {
    if (!this.isBrowser) return;
    // After the browser has applied the new geometry, not before it.
    requestAnimationFrame(() => this.panel().relayout());
  }

  // --- Dragging -----------------------------------------------------------

  protected startDrag(event: PointerEvent): void {
    this.begin(event, null);
  }

  protected startResize(event: PointerEvent, edge: ResizeEdge): void {
    if (event.button !== 0) return;
    this.begin(event, edge);
  }

  /**
   * Take the pointer, and keep it until the gesture ends.
   *
   * `setPointerCapture` is what stops the drag from breaking the moment the
   * pointer crosses into the editor, an iframe, or off the window entirely — and
   * `preventDefault` is what stops it from also selecting text on the way.
   */
  private begin(event: PointerEvent, edge: ResizeEdge | null): void {
    event.preventDefault();
    event.stopPropagation();

    const target = event.currentTarget as HTMLElement | null;
    target?.setPointerCapture?.(event.pointerId);

    this.gesture.set({
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      rect: this.editorWindow.floatingRect(),
      height: this.editorWindow.dockedHeight(),
      edge,
    });

    const move = (moveEvent: PointerEvent) => this.onPointerMove(moveEvent);
    const end = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== this.gesture()?.pointerId) return;
      target?.releasePointerCapture?.(endEvent.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      this.commit();
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  private onPointerMove(event: PointerEvent): void {
    const gesture = this.gesture();
    if (!gesture || event.pointerId !== gesture.pointerId) return;

    const dx = event.clientX - gesture.originX;
    const dy = event.clientY - gesture.originY;

    // Docked: the only thing you can pull is the top edge, and pulling it *down*
    // makes the panel shorter, not taller.
    if (this.mode() === 'docked') {
      this.liveHeight.set(this.clampHeight(gesture.height - dy));
      return;
    }

    this.live.set(gesture.edge ? this.resized(gesture, dx, dy) : this.moved(gesture, dx, dy));
  }

  private moved(gesture: Gesture, dx: number, dy: number): Rect {
    return this.contain({ ...gesture.rect, x: gesture.rect.x + dx, y: gesture.rect.y + dy });
  }

  /**
   * Resize from whichever edges the gesture holds.
   *
   * The north and west edges move the origin as well as the size, and they are
   * clamped so that pulling an edge *past* its opposite one stops at the minimum
   * width rather than turning the window inside out.
   */
  private resized(gesture: Gesture, dx: number, dy: number): Rect {
    const { rect, edge } = gesture;
    if (!edge) return rect;

    const minWidth = EDITOR_LIMITS.floatingWidth.min;
    const minHeight = EDITOR_LIMITS.floatingHeight.min;

    let { x, y, width, height } = rect;

    if (edge.includes('e')) width = rect.width + dx;
    if (edge.includes('s')) height = rect.height + dy;

    if (edge.includes('w')) {
      width = Math.max(minWidth, rect.width - dx);
      x = rect.x + (rect.width - width);
    }
    if (edge.includes('n')) {
      height = Math.max(minHeight, rect.height - dy);
      y = rect.y + (rect.height - height);
    }

    return this.contain({ x, y, width, height });
  }

  /** Keep a rect inside the workspace, as measured. */
  private contain(rect: Rect): Rect {
    const { width, height } = this.workspaceSize();
    if (width <= 0 || height <= 0) return rect;

    const w = Math.min(Math.max(rect.width, EDITOR_LIMITS.floatingWidth.min), width);
    const h = Math.min(Math.max(rect.height, EDITOR_LIMITS.floatingHeight.min), height);

    return {
      width: Math.round(w),
      height: Math.round(h),
      x: Math.round(Math.min(Math.max(rect.x, 0), Math.max(0, width - w))),
      y: Math.round(Math.min(Math.max(rect.y, 0), Math.max(0, height - h))),
    };
  }

  private clampHeight(height: number): number {
    const workspace = this.workspaceSize().height;
    const max = workspace > 0 ? workspace * 0.75 : EDITOR_LIMITS.dockedHeight.max;
    return Math.round(Math.min(Math.max(height, EDITOR_LIMITS.dockedHeight.min), max));
  }

  private workspaceSize(): { width: number; height: number } {
    const workspace = this.host.nativeElement.parentElement;
    if (!workspace) return { width: 0, height: 0 };
    const { width, height } = workspace.getBoundingClientRect();
    return { width, height };
  }

  /** The gesture is over: hand the result to the store, which persists it. */
  private commit(): void {
    const rect = this.live();
    const height = this.liveHeight();

    if (rect) this.editorWindow.setFloatingRect(rect);
    if (height !== null) this.editorWindow.setDockedHeight(height);

    this.gesture.set(null);
    this.live.set(null);
    this.liveHeight.set(null);
    this.scheduleRelayout();
  }

  // --- Keyboard -----------------------------------------------------------

  /**
   * Resize from the keyboard.
   *
   * A grip you can only reach with a mouse is a feature half the users do not
   * have. The handles are focusable separators, and the arrow keys pull them.
   */
  protected onHandleKeydown(event: KeyboardEvent, edge: ResizeEdge): void {
    const step = event.shiftKey ? NUDGE_FAST : NUDGE;

    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };

    const move = delta[event.key];
    if (!move) return;

    event.preventDefault();
    const [dx, dy] = move;

    if (this.mode() === 'docked') {
      this.editorWindow.setDockedHeight(this.clampHeight(this.editorWindow.dockedHeight() - dy));
      this.scheduleRelayout();
      return;
    }

    const gesture: Gesture = {
      pointerId: -1,
      originX: 0,
      originY: 0,
      rect: this.editorWindow.floatingRect(),
      height: this.editorWindow.dockedHeight(),
      edge,
    };
    this.editorWindow.setFloatingRect(this.resized(gesture, dx, dy));
    this.scheduleRelayout();
  }

  protected resizeLabel(edge: ResizeEdge): string {
    const names: Record<ResizeEdge, string> = {
      n: 'top edge',
      s: 'bottom edge',
      e: 'right edge',
      w: 'left edge',
      ne: 'top-right corner',
      nw: 'top-left corner',
      se: 'bottom-right corner',
      sw: 'bottom-left corner',
    };
    return `Resize the editor window from its ${names[edge]}. Use the arrow keys.`;
  }

  /** Put the caret back in the code — used after a keyboard mode change. */
  focusEditor(): void {
    this.panel().focusEditor();
  }
}
