import { Injectable, computed, inject, signal } from '@angular/core';

import { Preferences } from '../core/preferences';
import {
  DEFAULT_EDITOR_WINDOW,
  clampToViewport,
  sanitizeWindowState,
  type EditorDockSide,
  type EditorMode,
  type EditorWindowState,
} from '@shader-studio/shared/editor-prefs';
import type { Rect, Size } from '@shader-studio/shared/geometry';

/**
 * Where the editor is, and every legal way of moving it.
 *
 * The state itself lives in `Preferences`, which is what makes it survive a
 * reload; this service owns the *transitions*, and is the only thing allowed to
 * write them. Keeping them in one place is what makes "maximize, then restore"
 * reliably land you back in the floating window you came from rather than in
 * whatever the default was.
 *
 * Two things it deliberately does not own:
 *
 *  - The editor's contents. Nothing here destroys or recreates an editor, so no
 *    transition can cost you an undo stack; see `EditorShell`.
 *  - The workspace's size. The shell measures that and hands it over, because
 *    the service has no DOM and the server has no viewport at all.
 */

/** The smallest workspace we will still offer a floating window in. */
export const FLOATING_MIN_VIEWPORT = 700;

@Injectable({ providedIn: 'root' })
export class EditorWindow {
  private readonly preferences = inject(Preferences);

  /** The workspace the editor lives in, as last measured by the shell. */
  private readonly viewport = signal<Size>({ width: 0, height: 0 });

  readonly state = computed<EditorWindowState>(() => this.preferences.value().editorWindow);

  readonly open = computed(() => this.preferences.value().editorOpen);
  readonly restoreMode = computed(() => this.state().restoreMode);

  /**
   * Too narrow to drag a window around in, or to leave one lying on top of the
   * shader controls. Detaching is withdrawn rather than fudged.
   */
  readonly compact = computed(() => {
    const { width } = this.viewport();
    return width > 0 && width < FLOATING_MIN_VIEWPORT;
  });

  /**
   * The mode actually rendered, which is not always the mode stored.
   *
   * On a narrow screen a floating window falls back to the docked panel — but
   * only in what is *shown*. The stored mode is left alone, so rotating a tablet
   * back to landscape, or dragging a window wider, returns you to the floating
   * editor you had rather than quietly forgetting it.
   */
  readonly mode = computed<EditorMode>(() => {
    const mode = this.state().mode;
    if (this.compact() && mode === 'floating') return 'docked';
    return mode;
  });

  readonly docked = computed(() => this.mode() === 'docked');
  readonly floating = computed(() => this.mode() === 'floating');
  readonly maximized = computed(() => this.mode() === 'maximized');
  readonly minimized = computed(() => this.mode() === 'minimized');

  readonly dockSide = computed(() => {
    // Side docking needs horizontal room the same way a floating window does.
    // On a narrow screen the panel falls back to the bottom strip; the stored
    // side is left alone so widening the window restores it.
    if (this.compact()) return 'bottom';
    return this.state().dockSide;
  });

  readonly dockedHeight = computed(() => {
    const { height } = this.viewport();
    const stored = this.state().dockedHeight;
    if (height <= 0) return stored;

    // Never more than three quarters of the workspace: a docked panel that eats
    // the whole window has stopped being a panel, and the shader it is meant to
    // be previewing is the reason any of this exists.
    return Math.min(stored, Math.round(height * 0.75));
  });

  readonly dockedWidth = computed(() => {
    const { width } = this.viewport();
    const stored = this.state().dockedWidth;
    if (width <= 0) return stored;
    return Math.min(stored, Math.round(width * 0.75));
  });

  /**
   * The floating rect as it will actually be drawn: the stored one, pulled back
   * inside the workspace. Every reader goes through here, so a window remembered
   * against a monitor that no longer exists is recovered on the first frame
   * rather than lost.
   */
  readonly floatingRect = computed<Rect>(() =>
    clampToViewport(this.state().floating, this.viewport()),
  );

  setViewport(size: Size): void {
    const current = this.viewport();
    if (current.width === size.width && current.height === size.height) return;
    this.viewport.set(size);
  }

  // --- Visibility ---------------------------------------------------------

  toggleOpen(): void {
    this.preferences.patch({ editorOpen: !this.open() });
  }

  close(): void {
    this.preferences.patch({ editorOpen: false });
  }

  /**
   * Open the editor, and make sure it is somewhere you can see. Opening straight
   * back into the collapsed state you left it in looks, from the outside, exactly
   * like a button that does nothing.
   */
  openEditor(): void {
    const state = this.state();
    this.preferences.patch({
      editorOpen: true,
      editorWindow: state.mode === 'minimized' ? { ...state, mode: state.restoreMode } : state,
    });
  }

  // --- Modes --------------------------------------------------------------

  dock(side: EditorDockSide = this.state().dockSide): void {
    this.patch({ mode: 'docked', restoreMode: 'docked', dockSide: side });
  }

  detach(): void {
    this.patch({ mode: 'floating', restoreMode: 'floating' });
  }

  /**
   * Maximize and minimize both remember where they came from — but only if they
   * came from somewhere real. Minimizing a maximized editor and then restoring it
   * must not land in a third place nobody asked for.
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
    if (this.state().mode === 'maximized') this.restore();
    else this.maximize();
  }

  toggleMinimized(): void {
    if (this.state().mode === 'minimized') this.restore();
    else this.minimize();
  }

  private restorePointFrom(state: EditorWindowState): 'docked' | 'floating' {
    return state.mode === 'docked' || state.mode === 'floating' ? state.mode : state.restoreMode;
  }

  // --- Geometry -----------------------------------------------------------

  setDockedHeight(height: number): void {
    this.patch({ dockedHeight: height });
  }

  setDockedWidth(width: number): void {
    this.patch({ dockedWidth: width });
  }

  setFloatingRect(rect: Rect): void {
    this.patch({ floating: clampToViewport(rect, this.viewport()) });
  }

  /** Back to the default size and position, without touching the current mode. */
  resetGeometry(): void {
    this.patch({
      dockedHeight: DEFAULT_EDITOR_WINDOW.dockedHeight,
      dockedWidth: DEFAULT_EDITOR_WINDOW.dockedWidth,
      floating: clampToViewport(DEFAULT_EDITOR_WINDOW.floating, this.viewport()),
    });
  }

  /**
   * Everything written to preferences passes through the same sanitizer that
   * guards what is read back out of storage. A drag that produced a negative
   * height because the pointer crossed the handle is caught here, not in Monaco.
   */
  private patch(patch: Partial<EditorWindowState>): void {
    this.preferences.patch({
      editorWindow: sanitizeWindowState({ ...this.state(), ...patch }),
    });
  }
}
