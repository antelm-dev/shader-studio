import { Injectable, computed, inject, signal } from '@angular/core';

import type { Point, Rect, Size } from '@shader-studio/shared/geometry';
import { Preferences } from '../prefs/preferences';
import {
  DEFAULT_PREVIEW_WINDOW,
  clampMinimizedPoint,
  clampPreviewRect,
  defaultFloatingRect,
  sanitizePreviewWindow,
  type PreviewMode,
  type PreviewRestoreMode,
  type PreviewWindowState,
} from '@shader-studio/shared/preview-prefs';

/**
 * Where the preview is, and every legal way of moving it.
 *
 * The state lives in `Preferences`, which is what makes it survive a reload; this
 * service owns the *transitions*, and is the only thing allowed to write them.
 * Keeping them in one place is what makes "maximize, then restore" reliably land
 * you back in the floating window you came from rather than in whatever the
 * default was.
 *
 * Three things it deliberately does not own:
 *
 *  - The canvas. Nothing here creates, destroys or moves one, so no transition
 *    can cost you a WebGL context, a compiled program or the shader's clock. The
 *    modes are *styling* of the frame around a canvas that never moves; see
 *    `PreviewShell`.
 *  - The workspace's size. The shell measures the stage and hands it over,
 *    because the service has no DOM and the server has no viewport at all.
 *  - `EditorWindow`. The two windows resemble each other on screen and share
 *    nothing but `geometry`: the preview has no dock side, no tabs, and no way
 *    to be closed, and a base class holding the union of the two would have to
 *    invent all three.
 */
@Injectable({ providedIn: 'root' })
export class PreviewWindow {
  private readonly preferences = inject(Preferences);

  /**
   * The stage, in client coordinates, as last measured by the shell.
   *
   * A rect rather than a size, because the preview's frame is positioned against
   * the viewport (it is the page's background before it is anything else) while
   * its *geometry* is remembered against the workspace. The origin is what
   * converts between the two.
   */
  private readonly stage = signal<Rect>({ x: 0, y: 0, width: 0, height: 0 });

  readonly workspace = this.stage.asReadonly();

  /** The workspace as something to be clamped against: its size, without its origin. */
  readonly viewport = computed<Size>(() => {
    const { width, height } = this.stage();
    return { width, height };
  });

  readonly state = computed<PreviewWindowState>(() => this.preferences.value().previewWindow);

  readonly mode = computed<PreviewMode>(() => this.state().mode);
  readonly restoreMode = computed(() => this.state().restoreMode);

  readonly onStage = computed(() => this.mode() === 'stage');
  readonly floating = computed(() => this.mode() === 'floating');
  readonly maximized = computed(() => this.mode() === 'maximized');
  readonly minimized = computed(() => this.mode() === 'minimized');

  /** Anything that is not the stage is a window, and a window has a title bar. */
  readonly windowed = computed(() => !this.onStage());

  /**
   * The floating rect as it will actually be drawn: the stored one, pulled back
   * inside the workspace. Every reader goes through here, so a window remembered
   * against a monitor that no longer exists is recovered on the first frame
   * rather than left off-screen.
   */
  readonly floatingRect = computed<Rect>(() =>
    clampPreviewRect(this.state().floating, this.viewport()),
  );

  readonly minimizedPoint = computed<Point>(() =>
    clampMinimizedPoint(this.state().minimized, this.viewport()),
  );

  setWorkspace(rect: Rect): void {
    const current = this.stage();
    if (
      current.x === rect.x &&
      current.y === rect.y &&
      current.width === rect.width &&
      current.height === rect.height
    ) {
      return;
    }
    this.stage.set(rect);
  }

  // --- Modes --------------------------------------------------------------

  /** Back to being the page: the full workspace background, with no chrome. */
  showOnStage(): void {
    this.patch({ mode: 'stage', restoreMode: 'stage' });
  }

  detach(): void {
    this.patch({ mode: 'floating', restoreMode: 'floating' });
  }

  /**
   * Maximize and minimize both remember where they came from — but only if they
   * came from somewhere real. Minimizing a maximized preview and then restoring
   * it must not land in a third place nobody asked for.
   */
  maximize(): void {
    const state = this.state();
    if (state.mode === 'maximized') return;
    this.patch({ mode: 'maximized', restoreMode: this.restorePointFrom(state) });
  }

  minimize(): void {
    const state = this.state();
    if (state.mode === 'minimized') return;
    this.patch({ mode: 'minimized', restoreMode: this.restorePointFrom(state) });
  }

  restore(): void {
    this.patch({ mode: this.state().restoreMode });
  }

  toggleMaximized(): void {
    if (this.maximized()) this.restore();
    else this.maximize();
  }

  toggleMinimized(): void {
    if (this.minimized()) this.restore();
    else this.minimize();
  }

  /** The one command the stage itself offers: become a window, or stop being one. */
  toggleDetached(): void {
    if (this.onStage()) this.detach();
    else this.showOnStage();
  }

  private restorePointFrom(state: PreviewWindowState): PreviewRestoreMode {
    return state.mode === 'stage' || state.mode === 'floating' ? state.mode : state.restoreMode;
  }

  // --- Geometry -----------------------------------------------------------

  setFloatingRect(rect: Rect): void {
    this.patch({ floating: clampPreviewRect(rect, this.viewport()) });
  }

  setMinimizedPoint(point: Point): void {
    this.patch({ minimized: clampMinimizedPoint(point, this.viewport()) });
  }

  /**
   * Back to a sensible size and place, without touching the current mode.
   *
   * "Sensible" is measured against the workspace there is now, not the one the
   * window was last saved against — resetting is what you reach for precisely
   * when the remembered geometry has stopped making sense.
   */
  resetGeometry(): void {
    const viewport = this.viewport();
    this.patch({
      floating: defaultFloatingRect(viewport),
      minimized: clampMinimizedPoint(DEFAULT_PREVIEW_WINDOW.minimized, viewport),
    });
  }

  /**
   * Everything written to preferences passes through the same sanitizer that
   * guards what is read back out of storage. A drag that produced a negative
   * height because the pointer crossed the handle is caught here, not in CSS.
   */
  private patch(patch: Partial<PreviewWindowState>): void {
    this.preferences.patch({
      previewWindow: sanitizePreviewWindow({ ...this.state(), ...patch }),
    });
  }
}
