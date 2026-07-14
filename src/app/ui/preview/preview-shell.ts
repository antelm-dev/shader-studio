import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';

import { DesktopPlatform } from '../../desktop/desktop-platform';
import {
  containPoint,
  containRect,
  RESIZE_EDGES,
  RESIZE_NUDGE,
  RESIZE_NUDGE_FAST,
  resizeRect,
  type Point,
  type Rect,
  type ResizeEdge,
  type Size,
} from '@shader-studio/shared/geometry';
import {
  COLOR_SCHEME_OPTIONS,
  Preferences,
  colorSchemeIcon,
  type ColorScheme,
  type WorkspacePreferences,
} from '../../prefs/preferences';
import {
  PREVIEW_MINIMIZED_SIZE,
  PREVIEW_MINIMIZED_WIDTH,
  PREVIEW_MIN_FLOATING,
  type PreviewMode,
} from '@shader-studio/shared/preview-prefs';
import { ShaderStore } from '../../workspace/shader-store';
import { PreviewWindow } from '../../rendering/preview-window';
import { RendererHandle } from '../../rendering/renderer-handle';
import { ShaderCanvas } from '../../rendering/shader-canvas';
import { I18n } from '../../i18n/i18n';
import { TranslatePipe } from '../../i18n/translate.pipe';
import type { TranslationKey } from '../../i18n/keys';
import { PreviewWindowControls } from './preview-window-controls';

/**
 * The preview's frame: where it sits, and how you move and size it.
 *
 * The single most important line in this file is the one that renders
 * `<app-shader-canvas>`: there is exactly one, it is never inside an `@if`, and
 * it never moves in the DOM. The stage, a floating window, maximized and
 * collapsed are all *styling* of the frame around it. That is what preserves the
 * WebGL context, the compiled programs, the buffer contents and the shader's
 * clock across every transition — not because we save and restore them, but
 * because nothing is ever torn down to need restoring.
 *
 * Dragging and resizing are done with pointer events and pointer capture rather
 * than with the CSS `resize` this replaces, for three reasons the native one
 * could not give: a window that can be pulled from any edge rather than only its
 * bottom-right corner, a gesture that keeps tracking when the pointer leaves the
 * frame, and a grip a keyboard can reach.
 *
 * The frame is positioned against the viewport and its geometry is remembered
 * against the workspace; `PreviewStage` measures the one and `frame()` converts
 * between them.
 */

interface Gesture {
  pointerId: number;
  /** Pointer position when the gesture began, in client coordinates. */
  originX: number;
  originY: number;
  /** The geometry as it was when the gesture began, in workspace coordinates. */
  rect: Rect;
  point: Point;
  /** The edges being pulled, or `null` for a move. */
  edge: ResizeEdge | null;
}

@Component({
  selector: 'app-preview-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatDividerModule,
    MatIconModule,
    MatMenuModule,
    PreviewWindowControls,
    ShaderCanvas,
    TranslatePipe,
  ],
  template: `
    <!-- Every mode but the stage is a window, and a window says what it is and
         how to put it back. -->
    @if (windowed()) {
      <div
        class="title-bar"
        [class.draggable]="draggable()"
        (pointerdown)="onTitlePointerDown($event)"
        (dblclick)="onTitleDoubleClick($event)"
      >
        <mat-icon class="title-icon" aria-hidden="true">blur_on</mat-icon>
        <span class="title">{{ 'preview.title' | translate }}</span>
        <app-preview-window-controls [menu]="previewMenu" />
      </div>
    }

    <!-- One canvas, one context, mounted once. The context menu is on the body
         rather than the canvas so that the same menu the title bar's button opens
         is the one a right-click on the shader opens. -->
    <div class="body" [class.collapsed]="minimized()" [matContextMenuTriggerFor]="previewMenu">
      <app-shader-canvas />
    </div>

    <mat-menu #previewMenu="matMenu">
      @if (!stageOnly()) {
        <button mat-menu-item type="button" (click)="preview.toggleDetached()">
          <mat-icon>{{ onStage() ? 'open_in_new' : 'wallpaper' }}</mat-icon>
          <span>{{
            (onStage() ? 'action.detachPreview' : 'action.returnToStage') | translate
          }}</span>
        </button>

        @if (windowed()) {
          <button
            mat-menu-item
            type="button"
            [attr.aria-pressed]="maximized()"
            (click)="preview.toggleMaximized()"
          >
            <mat-icon>{{ maximized() ? 'close_fullscreen' : 'open_in_full' }}</mat-icon>
            <span>{{
              (maximized() ? 'action.restorePreview' : 'action.maximizePreview') | translate
            }}</span>
          </button>
          <button
            mat-menu-item
            type="button"
            [attr.aria-expanded]="!minimized()"
            (click)="preview.toggleMinimized()"
          >
            <mat-icon>{{ minimized() ? 'expand_less' : 'minimize' }}</mat-icon>
            <span>{{
              (minimized() ? 'action.expandPreview' : 'action.collapsePreview') | translate
            }}</span>
          </button>
          <button mat-menu-item type="button" (click)="preview.resetGeometry()">
            <mat-icon>aspect_ratio</mat-icon>
            <span>{{ 'action.resetWindow' | translate }}</span>
          </button>
        }

        <mat-divider />
      }

      <button mat-menu-item type="button" (click)="savePng()">
        <mat-icon>photo_camera</mat-icon>
        <span>{{ 'action.savePng' | translate }}</span>
        <span class="hint">S</span>
      </button>
      <button mat-menu-item type="button" (click)="togglePause()">
        <mat-icon>{{ preferences.value().paused ? 'play_arrow' : 'pause' }}</mat-icon>
        <span>{{
          (preferences.value().paused ? 'action.resume' : 'action.pause') | translate
        }}</span>
        <span class="hint">Space</span>
      </button>
      <button
        mat-menu-item
        type="button"
        [disabled]="!store.record()"
        (click)="store.resetParams()"
      >
        <mat-icon>restart_alt</mat-icon>
        <span>{{ 'action.resetParameters' | translate }}</span>
      </button>

      <mat-divider />

      <button mat-menu-item type="button" (click)="toggle('guiVisible')">
        <mat-icon>{{ preferences.value().guiVisible ? 'visibility_off' : 'tune' }}</mat-icon>
        <span>{{
          (preferences.value().guiVisible ? 'action.hideControls' : 'action.showControls')
            | translate
        }}</span>
        <span class="hint">H</span>
      </button>
      <button mat-menu-item type="button" (click)="toggle('editorOpen')">
        <mat-icon>code</mat-icon>
        <span>{{
          (preferences.value().editorOpen ? 'action.hideEditor' : 'action.showEditor') | translate
        }}</span>
      </button>

      <mat-divider />

      <button mat-menu-item type="button" [matMenuTriggerFor]="themeMenu">
        <mat-icon>{{ themeIcon() }}</mat-icon>
        <span>{{ 'menu.theme' | translate }}</span>
      </button>

      @if (desktop.available) {
        <mat-divider />
        <button mat-menu-item type="button" (click)="desktop.toggleFullscreen()">
          <mat-icon>{{ desktop.fullscreen() ? 'fullscreen_exit' : 'fullscreen' }}</mat-icon>
          <span>{{
            (desktop.fullscreen() ? 'action.exitFullscreen' : 'action.enterFullscreen') | translate
          }}</span>
          <span class="hint">F11</span>
        </button>
      }
    </mat-menu>

    <mat-menu #themeMenu="matMenu">
      @for (option of colorSchemeOptions; track option.value) {
        <button
          mat-menu-item
          type="button"
          [attr.aria-checked]="preferences.value().colorScheme === option.value"
          (click)="setColorScheme(option.value)"
        >
          <mat-icon>{{ option.icon }}</mat-icon>
          <span>{{ themeLabel(option.value) }}</span>
          @if (preferences.value().colorScheme === option.value) {
            <mat-icon class="hint" aria-hidden="true">check</mat-icon>
          }
        </button>
      }
    </mat-menu>

    <!-- Eight grips, so the window can be pulled from any edge or corner. Only
         when floating: the stage has no edges of its own, a maximized window's
         are the workspace's, and a collapsed one is a bar. -->
    @if (floating()) {
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
    /* Fixed, not absolute: on the stage the preview *is* the page, and the
       chrome is drawn on top of it. A background cannot be a child of the thing
       covering it, so the frame is positioned against the viewport and converts
       the workspace's coordinates itself. */
    :host {
      position: fixed;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: #0a0c10;
    }

    /* No transition on the geometry, deliberately. Every frame of an animated
       resize is a ResizeObserver callback, and every one of those reallocates the
       drawing buffer and every render target hanging off it. The editor can
       afford to slide; a live WebGL surface cannot. */

    :host(.stage) {
      inset: 0;
      z-index: 0;
    }

    /* Above the chrome, which is what "detached" has always meant here: the
       preview is the subject, and a window over the shader that the toolbar could
       cover would be a window you have to fight. */
    :host(.floating),
    :host(.minimized) {
      z-index: 4;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: var(--mat-sys-corner-medium, 8px);
      box-shadow: var(--mat-sys-level4);
    }

    :host(.maximized) {
      z-index: 4;
      border: 1px solid var(--mat-sys-outline-variant);
    }

    /* --- Title bar ------------------------------------------------------- */
    /* The editor toolbar's metrics, to the pixel: 34px tall, 16px icons, the
       same divider beneath it. The two windows have to read as one interface. */

    .title-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 0 0 auto;
      min-height: 34px;
      padding: 2px 5px 2px 8px;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
      background: color-mix(in srgb, var(--mat-sys-surface-container-high) 92%, transparent);
      backdrop-filter: blur(18px);
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-label-large);
      user-select: none;
      cursor: context-menu;
      touch-action: none;
    }

    .title-bar.draggable {
      cursor: move;
    }

    .title-icon {
      flex: 0 0 auto;
      width: 16px;
      height: 16px;
      font-size: 16px;
      color: var(--mat-sys-primary);
    }

    .title {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* --- Body ------------------------------------------------------------ */
    /* The title bar takes its height off the top and the canvas gets the rest,
       so the bar never covers a pixel of the rendered image. */

    .body {
      display: flex;
      flex: 1 1 auto;
      min-height: 0;
    }

    /* Collapsed to the bar. The canvas keeps its context and its clock — it is
       simply given no room, which is the whole point of collapsing. */
    .body.collapsed {
      flex: 0 0 0;
      height: 0;
      overflow: hidden;
    }

    app-shader-canvas {
      flex: 1 1 auto;
      min-width: 0;
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
      top: 0;
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

    .hint {
      margin-left: auto;
      padding-left: 24px;
    }
  `,
  host: {
    '[class.stage]': 'onStage()',
    '[class.floating]': 'floating()',
    '[class.maximized]': 'maximized()',
    '[class.minimized]': 'minimized()',
    '[style.left.px]': 'frame()?.x',
    '[style.top.px]': 'frame()?.y',
    '[style.width.px]': 'frame()?.width',
    '[style.height.px]': 'frameHeight()',
    role: 'region',
    'aria-label': 'Shader preview',
  },
})
export class PreviewShell {
  protected readonly preview = inject(PreviewWindow);
  protected readonly store = inject(ShaderStore);
  protected readonly preferences = inject(Preferences);
  protected readonly desktop = inject(DesktopPlatform);
  protected readonly i18n = inject(I18n);
  private readonly handle = inject(RendererHandle);

  /**
   * The output window renders the same shader with none of the chrome, and it
   * reads the same stored preferences as the tab that spawned it. Without this it
   * would faithfully reproduce the floating window you left the main window in —
   * on a screen that exists to show the shader and nothing else.
   *
   * The *stored* mode is left alone, exactly as `EditorWindow.compact` leaves it:
   * this is what is shown, not what is remembered.
   */
  readonly stageOnly = input(false);

  protected readonly edges = RESIZE_EDGES;

  protected readonly mode = computed<PreviewMode>(() =>
    this.stageOnly() ? 'stage' : this.preview.mode(),
  );

  protected readonly onStage = computed(() => this.mode() === 'stage');
  protected readonly floating = computed(() => this.mode() === 'floating');
  protected readonly maximized = computed(() => this.mode() === 'maximized');
  protected readonly minimized = computed(() => this.mode() === 'minimized');
  protected readonly windowed = computed(() => !this.onStage());

  /** A maximized window fills the workspace; there is nothing to drag it to. */
  protected readonly draggable = computed(() => this.floating() || this.minimized());

  protected readonly colorSchemeOptions = COLOR_SCHEME_OPTIONS;
  protected readonly themeIcon = computed(() =>
    colorSchemeIcon(this.preferences.value().colorScheme),
  );

  /**
   * The gesture in flight, if any.
   *
   * While it is set, the frame renders from `live` instead of from the store.
   * Committing every pointermove to `Preferences` would serialise the whole
   * preference object to `localStorage` sixty times a second, for a value that is
   * only interesting once the user lets go.
   */
  private readonly gesture = signal<Gesture | null>(null);
  private readonly liveRect = signal<Rect | null>(null);
  private readonly livePoint = signal<Point | null>(null);

  private readonly rect = computed<Rect>(() => this.liveRect() ?? this.preview.floatingRect());
  private readonly point = computed<Point>(() => this.livePoint() ?? this.preview.minimizedPoint());

  /**
   * Where the frame goes, in client coordinates — the stored geometry, offset by
   * the workspace's own origin on screen. `null` on the stage, where the frame is
   * pinned to the viewport by CSS and has no geometry of its own.
   */
  protected readonly frame = computed<Rect | null>(() => {
    const workspace = this.preview.workspace();
    const mode = this.mode();

    if (mode === 'stage') return null;

    if (mode === 'maximized') return workspace;

    if (mode === 'minimized') {
      const point = this.point();
      return {
        x: workspace.x + point.x,
        y: workspace.y + point.y,
        width: PREVIEW_MINIMIZED_WIDTH,
        height: PREVIEW_MINIMIZED_SIZE.height,
      };
    }

    const rect = this.rect();
    return {
      x: workspace.x + rect.x,
      y: workspace.y + rect.y,
      width: rect.width,
      height: rect.height,
    };
  });

  /** Collapsed, the frame is as tall as its bar — which only the bar can know. */
  protected readonly frameHeight = computed<number | null>(() =>
    this.minimized() ? null : (this.frame()?.height ?? null),
  );

  // --- Commands -----------------------------------------------------------

  protected toggle(key: 'editorOpen' | 'guiVisible'): void {
    this.preferences.patch({
      [key]: !this.preferences.value()[key],
    } as Partial<WorkspacePreferences>);
  }

  protected togglePause(): void {
    this.preferences.patch({ paused: !this.preferences.value().paused });
  }

  protected setColorScheme(colorScheme: ColorScheme): void {
    this.preferences.patch({ colorScheme });
  }

  protected async savePng(): Promise<void> {
    const name = this.store.record()?.id ?? 'shader';
    const saved = await this.handle.screenshot(name);
    if (!saved) {
      this.store.notice.set({ text: this.i18n.t('preview.nothingToCapture'), error: true });
    }
  }

  // --- Dragging -----------------------------------------------------------

  protected onTitlePointerDown(event: PointerEvent): void {
    if (!this.draggable() || event.button !== 0) return;

    // The controls live in the bar, and a click on one of them is not a drag.
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, input')) return;

    this.begin(event, null);
  }

  /** Double-clicking a title bar has toggled maximize since windows had them. */
  protected onTitleDoubleClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, input')) return;

    this.preview.toggleMaximized();
  }

  protected startResize(event: PointerEvent, edge: ResizeEdge): void {
    if (event.button !== 0) return;
    this.begin(event, edge);
  }

  /**
   * Take the pointer, and keep it until the gesture ends.
   *
   * `setPointerCapture` is what stops the drag from breaking the moment the
   * pointer crosses onto the canvas, into the editor, or off the window entirely
   * — and `preventDefault` is what stops it from also selecting text on the way.
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
      rect: this.preview.floatingRect(),
      point: this.preview.minimizedPoint(),
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

    if (gesture.edge) {
      this.liveRect.set(this.resized(gesture, dx, dy));
      return;
    }

    // A collapsed bar is moved by its corner: it has no size to speak of, and
    // nothing to resize.
    if (this.minimized()) {
      this.livePoint.set(
        containPoint(
          { x: gesture.point.x + dx, y: gesture.point.y + dy },
          this.viewport(),
          PREVIEW_MINIMIZED_SIZE,
        ),
      );
      return;
    }

    this.liveRect.set(
      this.contain({ ...gesture.rect, x: gesture.rect.x + dx, y: gesture.rect.y + dy }),
    );
  }

  /**
   * Resize from whichever edges the gesture holds.
   *
   * The north and west edges move the origin as well as the size, and they are
   * clamped so that pulling an edge *past* its opposite one stops at the minimum
   * size rather than turning the window inside out.
   */
  private resized(gesture: Gesture, dx: number, dy: number): Rect {
    const { rect, edge } = gesture;
    if (!edge) return rect;

    return this.contain(resizeRect(rect, edge, dx, dy, PREVIEW_MIN_FLOATING));
  }

  /** Keep a rect inside the workspace, so its title bar is always reachable. */
  private contain(rect: Rect): Rect {
    return containRect(rect, this.viewport(), PREVIEW_MIN_FLOATING);
  }

  private viewport(): Size {
    return this.preview.viewport();
  }

  /** The gesture is over: hand the result to the service, which persists it. */
  private commit(): void {
    const rect = this.liveRect();
    const point = this.livePoint();

    if (rect) this.preview.setFloatingRect(rect);
    if (point) this.preview.setMinimizedPoint(point);

    this.gesture.set(null);
    this.liveRect.set(null);
    this.livePoint.set(null);
  }

  // --- Keyboard -----------------------------------------------------------

  /**
   * Resize from the keyboard.
   *
   * A grip you can only reach with a mouse is a feature half the users do not
   * have — and it is the whole reason the native `resize: both` had to go. The
   * handles are focusable separators, and the arrow keys pull them.
   */
  protected onHandleKeydown(event: KeyboardEvent, edge: ResizeEdge): void {
    const step = event.shiftKey ? RESIZE_NUDGE_FAST : RESIZE_NUDGE;

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

    const gesture: Gesture = {
      pointerId: -1,
      originX: 0,
      originY: 0,
      rect: this.preview.floatingRect(),
      point: this.preview.minimizedPoint(),
      edge,
    };

    this.preview.setFloatingRect(this.resized(gesture, dx, dy));
  }

  protected themeLabel(theme: ColorScheme): string {
    return this.i18n.t(`theme.${theme}`);
  }

  protected resizeLabel(edge: ResizeEdge): string {
    const keys: Record<ResizeEdge, TranslationKey> = {
      n: 'preview.edge.n',
      s: 'preview.edge.s',
      e: 'preview.edge.e',
      w: 'preview.edge.w',
      ne: 'preview.edge.ne',
      nw: 'preview.edge.nw',
      se: 'preview.edge.se',
      sw: 'preview.edge.sw',
    };
    return this.i18n.t('preview.resizeEdge', { edge: this.i18n.t(keys[edge]) });
  }
}
