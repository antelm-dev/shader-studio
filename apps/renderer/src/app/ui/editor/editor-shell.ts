import { isPlatformBrowser } from '@angular/common';
import {
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

import { EDITOR_LIMITS } from '@shader-studio/shared/editor-prefs';
import {
  arrowKeyDelta,
  containRect,
  resizeRect,
  type Rect,
  type ResizeEdge,
} from '@shader-studio/shared/geometry';
import { EditorWindow } from '../../editor/editor-window';
import { EditorPanel } from './editor-panel';
import { PointerGesture } from '../layout/pointer-gesture';
import { ResizeHandles } from '../layout/resize-handles';
import { WorkspaceWindowStack } from '../workspace-window-stack';

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

interface Gesture {
  /** The rect (or docked size) as it was when the gesture began. */
  rect: Rect;
  height: number;
  width: number;
  edge: ResizeEdge | null;
}

@Component({
  selector: 'app-editor-shell',
  imports: [EditorPanel, ResizeHandles],
  template: `
    <!-- The docked panel's free edge. A separator, so a keyboard can resize it. -->
    @if (mode() === 'docked') {
      <div
        class="handle handle-{{ dockResizeEdge() }}"
        role="separator"
        tabindex="0"
        [attr.aria-orientation]="dockSide() === 'bottom' ? 'horizontal' : 'vertical'"
        [attr.aria-label]="dockResizeLabel()"
        [attr.aria-valuenow]="dockSize()"
        [attr.aria-valuemin]="dockSizeLimits().min"
        [attr.aria-valuemax]="dockSizeLimits().max"
        (pointerdown)="startResize($event, dockResizeEdge())"
        (keydown)="onHandleKeydown($event, dockResizeEdge())"
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
      <app-resize-handles
        [label]="resizeLabel"
        (pointerDown)="startResize($event.event, $event.edge)"
        (keyDown)="onHandleKeydown($event.event, $event.edge)"
      />
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

    /* --- Docked: a cell of the workspace grid. --------------------------- */

    :host(.docked),
    :host(.minimized) {
      grid-area: editor;
    }

    :host(.docked.dock-bottom),
    :host(.minimized.dock-bottom) {
      border-width: 1px 0 0;
    }

    :host(.docked.dock-left),
    :host(.minimized.dock-left) {
      border-width: 0 1px 0 0;
      align-self: stretch;
      min-width: 0;
    }

    :host(.docked.dock-right),
    :host(.minimized.dock-right) {
      border-width: 0 0 0 1px;
      align-self: stretch;
      min-width: 0;
    }

    :host(.minimized.dock-left),
    :host(.minimized.dock-right) {
      align-self: start;
    }

    /* --- Maximized: the whole workspace. --------------------------------- */

    :host(.maximized) {
      position: absolute;
      inset: 0;
      border-width: 1px 0 0;
    }

    /* --- Floating: a window over the shader. ----------------------------- */

    :host(.floating) {
      position: absolute;
      overflow: hidden;
      border-radius: var(--mat-sys-corner-medium, 8px);
      box-shadow: var(--mat-sys-level4);
    }

    /* Matches the docked handle's own north grip, so the top edge is grabbable
       from the same distance in every mode. */
    app-resize-handles {
      --resize-handle-top-offset: -3px;
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

    /* Only n, e and w: the docked panel's free edge is the only one this
       handle is for — see app-resize-handles for the floating window's
       other seven. */
    .handle-n {
      left: 0;
      right: 0;
      height: 6px;
      cursor: ns-resize;
      top: -3px;
    }

    .handle-e,
    .handle-w {
      top: 0;
      bottom: 0;
      width: 6px;
      cursor: ew-resize;
    }

    .handle-e {
      right: 0;
    }

    .handle-w {
      left: 0;
    }

    /* The docked handle sits on the panel's free edge and has to be
       grabbable from just outside it. */
    :host(.docked) .handle-n {
      height: 7px;
      top: -4px;
    }

    :host(.docked) .handle-e {
      width: 7px;
      right: -4px;
    }

    :host(.docked) .handle-w {
      width: 7px;
      left: -4px;
    }
  `,
  host: {
    '[class.docked]': 'mode() === "docked"',
    '[class.floating]': 'mode() === "floating"',
    '[class.maximized]': 'mode() === "maximized"',
    '[class.minimized]': 'mode() === "minimized"',
    '[class.dock-bottom]': 'dockSide() === "bottom"',
    '[class.dock-left]': 'dockSide() === "left"',
    '[class.dock-right]': 'dockSide() === "right"',
    '[class.dragging]': 'dragging()',
    '[class.animating]': '!dragging()',
    '[style.height.px]': 'hostHeight()',
    '[style.width.px]': 'hostWidth()',
    '[style.left.px]': 'hostRect()?.x',
    '[style.top.px]': 'hostRect()?.y',
    '[style.z-index]': 'windowZIndex()',
    '(pointerdown)': 'activate()',
    '(focusin)': 'activate()',
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
  private readonly windowStack = inject(WorkspaceWindowStack);

  private readonly panel = viewChild.required(EditorPanel);

  protected readonly mode = this.editorWindow.mode;
  protected readonly dockSide = this.editorWindow.dockSide;
  protected readonly windowZIndex = computed(() =>
    this.mode() === 'floating' || this.mode() === 'maximized'
      ? this.windowStack.zIndex('editor')
      : null,
  );

  protected readonly dockResizeEdge = computed<ResizeEdge>(() => {
    const side = this.dockSide();
    if (side === 'left') return 'e';
    if (side === 'right') return 'w';
    return 'n';
  });

  protected readonly dockSize = computed(() =>
    this.dockSide() === 'bottom'
      ? this.editorWindow.dockedHeight()
      : this.editorWindow.dockedWidth(),
  );

  protected readonly dockSizeLimits = computed(() =>
    this.dockSide() === 'bottom' ? this.limits.dockedHeight : this.limits.dockedWidth,
  );

  /**
   * The gesture in flight, if any.
   *
   * While it is set, the frame renders from `live` instead of from the store.
   * Committing every pointermove to `Preferences` would serialise the whole
   * preference object to `localStorage` sixty times a second, for a value that is
   * only interesting once the user lets go.
   */
  private readonly pointerGesture = new PointerGesture();
  protected readonly dragging = this.pointerGesture.dragging;
  private readonly live = signal<Rect | null>(null);
  private readonly liveHeight = signal<number | null>(null);
  private readonly liveWidth = signal<number | null>(null);

  /** Position — floating only; the other modes are laid out by CSS. */
  protected readonly hostRect = computed<Rect | null>(() => {
    if (this.mode() !== 'floating') return null;
    return this.live() ?? this.editorWindow.floatingRect();
  });

  protected readonly hostHeight = computed<number | null>(() => {
    const mode = this.mode();
    if (mode === 'floating') return (this.live() ?? this.editorWindow.floatingRect()).height;
    if (mode === 'docked' && this.dockSide() === 'bottom') {
      return this.liveHeight() ?? this.editorWindow.dockedHeight();
    }
    // Side-docked panels stretch with the grid row; maximized fills its
    // container; minimized shrinks to its toolbar.
    return null;
  });

  protected readonly hostWidth = computed<number | null>(() => {
    const mode = this.mode();
    if (mode === 'floating') return (this.live() ?? this.editorWindow.floatingRect()).width;
    if ((mode === 'docked' || mode === 'minimized') && this.dockSide() !== 'bottom') {
      return this.liveWidth() ?? this.editorWindow.dockedWidth();
    }
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
      this.dockSide();
      this.hostHeight();
      this.hostWidth();
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
    this.activate();
    event.preventDefault();
    event.stopPropagation();

    const gesture: Gesture = {
      rect: this.editorWindow.floatingRect(),
      height: this.editorWindow.dockedHeight(),
      width: this.editorWindow.dockedWidth(),
      edge,
    };

    const target = event.currentTarget as HTMLElement | null;
    this.pointerGesture.begin(event, target, {
      onMove: (dx, dy) => this.applyMove(gesture, dx, dy),
      onCommit: (dx, dy) => {
        this.applyMove(gesture, dx, dy);
        this.commit();
      },
    });
  }

  private applyMove(gesture: Gesture, dx: number, dy: number): void {
    // Docked: pull the free edge. Bottom grows upward; left grows rightward;
    // right grows leftward.
    if (this.mode() === 'docked') {
      const side = this.dockSide();
      if (side === 'bottom') {
        this.liveHeight.set(this.clampHeight(gesture.height - dy));
      } else if (side === 'left') {
        this.liveWidth.set(this.clampWidth(gesture.width + dx));
      } else {
        this.liveWidth.set(this.clampWidth(gesture.width - dx));
      }
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

    const min = {
      width: EDITOR_LIMITS.floatingWidth.min,
      height: EDITOR_LIMITS.floatingHeight.min,
    };
    return this.contain(resizeRect(rect, edge, dx, dy, min));
  }

  /** Keep a rect inside the workspace, as measured. */
  private contain(rect: Rect): Rect {
    const min = {
      width: EDITOR_LIMITS.floatingWidth.min,
      height: EDITOR_LIMITS.floatingHeight.min,
    };
    return containRect(rect, this.workspaceSize(), min);
  }

  private clampHeight(height: number): number {
    const workspace = this.workspaceSize().height;
    const max = workspace > 0 ? workspace * 0.75 : EDITOR_LIMITS.dockedHeight.max;
    return Math.round(Math.min(Math.max(height, EDITOR_LIMITS.dockedHeight.min), max));
  }

  private clampWidth(width: number): number {
    const workspace = this.workspaceSize().width;
    const max = workspace > 0 ? workspace * 0.75 : EDITOR_LIMITS.dockedWidth.max;
    return Math.round(Math.min(Math.max(width, EDITOR_LIMITS.dockedWidth.min), max));
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
    const width = this.liveWidth();

    if (rect) this.editorWindow.setFloatingRect(rect);
    if (height !== null) this.editorWindow.setDockedHeight(height);
    if (width !== null) this.editorWindow.setDockedWidth(width);

    this.live.set(null);
    this.liveHeight.set(null);
    this.liveWidth.set(null);
    this.scheduleRelayout();
  }

  protected activate(): void {
    if (this.mode() === 'floating' || this.mode() === 'maximized') {
      this.windowStack.activate('editor');
    }
  }

  // --- Keyboard -----------------------------------------------------------

  /**
   * Resize from the keyboard.
   *
   * A grip you can only reach with a mouse is a feature half the users do not
   * have. The handles are focusable separators, and the arrow keys pull them.
   */
  protected onHandleKeydown(event: KeyboardEvent, edge: ResizeEdge): void {
    const move = arrowKeyDelta(event);
    if (!move) return;

    event.preventDefault();
    const [dx, dy] = move;

    if (this.mode() === 'docked') {
      const side = this.dockSide();
      if (side === 'bottom') {
        this.editorWindow.setDockedHeight(this.clampHeight(this.editorWindow.dockedHeight() - dy));
      } else if (side === 'left') {
        this.editorWindow.setDockedWidth(this.clampWidth(this.editorWindow.dockedWidth() + dx));
      } else {
        this.editorWindow.setDockedWidth(this.clampWidth(this.editorWindow.dockedWidth() - dx));
      }
      this.scheduleRelayout();
      return;
    }

    const gesture: Gesture = {
      rect: this.editorWindow.floatingRect(),
      height: this.editorWindow.dockedHeight(),
      width: this.editorWindow.dockedWidth(),
      edge,
    };
    this.editorWindow.setFloatingRect(this.resized(gesture, dx, dy));
    this.scheduleRelayout();
  }

  protected dockResizeLabel(): string {
    const side = this.dockSide();
    const keys = side === 'bottom' ? 'up and down arrow keys' : 'left and right arrow keys';
    return `Resize the editor panel. Use the ${keys}.`;
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
