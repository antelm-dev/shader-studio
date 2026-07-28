/**
 * Bridges Preferences, SurfaceRegistry, and SurfaceController for Agent 06.
 *
 * Hydrates the registry from legacy or versioned layout prefs; persists
 * `surfacesLayout` after successful commands and gesture commits — never on
 * pointermove.
 *
 * SSR-safe: hydration runs in the browser only.
 */

import { Injectable, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

import type { Point, Rect } from '@shader-studio/shared/geometry';
import {
  DEFAULT_EDITOR_GROUP_ID,
  WELL_KNOWN_SURFACE_IDS,
  createDefaultSurface,
  editorSurfaceId,
  isContainedPlacement,
  migrateLayoutFromPreferences,
  type DockSide,
  type SurfaceId,
  type SurfaceRecord,
} from '@shader-studio/shared/surfaces';

import { DesktopPlatform } from '../desktop/desktop-platform';
import { Preferences } from '../prefs/preferences';
import { SurfaceController, type SurfaceCommandResult } from './surface-controller';
import { SurfaceRegistry } from './surface-registry';
import type { SurfaceCommandContext } from './surface-commands';

export const PREVIEW_SURFACE_ID = WELL_KNOWN_SURFACE_IDS.preview;
export const DEFAULT_EDITOR_SURFACE_ID = editorSurfaceId(DEFAULT_EDITOR_GROUP_ID);

@Injectable({ providedIn: 'root' })
export class SurfaceLayoutService {
  private readonly preferences = inject(Preferences);
  private readonly registry = inject(SurfaceRegistry);
  private readonly controller = inject(SurfaceController);
  private readonly desktop = inject(DesktopPlatform);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** Preview stage rect in client coordinates (origin + size). */
  private readonly previewWorkspaceRect = signal<Rect>({ x: 0, y: 0, width: 0, height: 0 });

  readonly previewId = PREVIEW_SURFACE_ID;
  readonly editorId = DEFAULT_EDITOR_SURFACE_ID;

  readonly previewWorkspace = this.previewWorkspaceRect.asReadonly();

  readonly preview = computed(() => this.surfaceRecord(this.previewId, 'preview'));
  readonly editor = computed(() => this.surfaceRecord(this.editorId, 'editor'));

  readonly editorOpen = computed(() => this.editor().open);

  readonly editorDockSide = computed<DockSide>(() => {
    const placement = this.editor().placement;
    if (!isContainedPlacement(placement)) return 'bottom';
    if (placement.mode === 'docked') return placement.side;
    if (placement.mode === 'maximized' || placement.mode === 'minimized') {
      const restore = placement.restore;
      if (restore.mode === 'docked') return restore.side;
    }
    return this.readLegacyEditorDockSide();
  });

  constructor() {
    if (this.isBrowser) {
      this.hydrateFromPreferences();
    }
  }

  /** Register stable preview and primary-editor instances if missing. */
  hydrateFromPreferences(): void {
    const prefs = this.preferences.value();
    const layout =
      prefs.surfacesLayout ??
      migrateLayoutFromPreferences(prefs, {
        viewport: {
          width: this.previewWorkspaceRect().width,
          height: this.previewWorkspaceRect().height,
        },
      });
    this.registry.hydrate(layout);
    this.registry.ensure('preview');
    this.registry.ensure('editor', {
      id: this.editorId,
      chrome: { kind: 'editor', editorGroupId: DEFAULT_EDITOR_GROUP_ID },
    });
  }

  setPreviewWorkspace(rect: Rect): void {
    const current = this.previewWorkspaceRect();
    if (
      current.x === rect.x &&
      current.y === rect.y &&
      current.width === rect.width &&
      current.height === rect.height
    ) {
      return;
    }
    this.previewWorkspaceRect.set(rect);
    this.registry.setViewport({ width: rect.width, height: rect.height });
  }

  commandContext(extra: Partial<SurfaceCommandContext> = {}): SurfaceCommandContext {
    return {
      allowNative: this.desktop.available,
      remainingEditorGroups: Math.max(0, this.registry.openEditorGroupCount() - 1),
      ...extra,
    };
  }

  persistLayout(): void {
    const layout = this.registry.snapshot();
    const editor = layout.surfaces.find((surface) => surface.id === this.editorId);
    this.preferences.patch({
      surfacesLayout: layout,
      editorOpen: editor?.open ?? false,
    });
  }

  apply(result: SurfaceCommandResult): boolean {
    if (!result.ok) return false;
    this.persistLayout();
    return true;
  }

  activate(id: SurfaceId): void {
    this.controller.activate(id);
  }

  zIndex(id: SurfaceId): number | null {
    return this.registry.zIndex(id);
  }

  showOnStage(id: SurfaceId = this.previewId): boolean {
    return this.apply(this.controller.showOnStage(id));
  }

  float(id: SurfaceId, rect?: Rect): boolean {
    return this.apply(this.controller.float(id, rect));
  }

  dock(id: SurfaceId, side?: DockSide, size?: number): boolean {
    return this.apply(this.controller.dock(id, side, size));
  }

  maximize(id: SurfaceId): boolean {
    return this.apply(this.controller.maximize(id));
  }

  minimize(id: SurfaceId, point?: Point): boolean {
    return this.apply(this.controller.minimize(id, point));
  }

  restore(id: SurfaceId): boolean {
    return this.apply(this.controller.restore(id));
  }

  toggleMaximized(id: SurfaceId): boolean {
    const surface = this.registry.get(id);
    if (!surface || !isContainedPlacement(surface.placement)) return false;
    if (surface.placement.mode === 'maximized') return this.restore(id);
    return this.maximize(id);
  }

  toggleMinimized(id: SurfaceId): boolean {
    const surface = this.registry.get(id);
    if (!surface || !isContainedPlacement(surface.placement)) return false;
    if (surface.placement.mode === 'minimized') return this.restore(id);
    return this.minimize(id);
  }

  resetGeometry(id: SurfaceId): boolean {
    return this.apply(this.controller.resetGeometry(id));
  }

  close(id: SurfaceId): boolean {
    const surface = this.registry.get(id);
    if (!surface) return false;

    if (surface.kind === 'editor') {
      const remaining = Math.max(0, this.registry.openEditorGroupCount() - 1);
      if (remaining < 1) {
        // Sole editor group: hide the surface UI without rejecting (legacy editorOpen).
        this.registry.upsert({ ...surface, open: false });
        this.persistLayout();
        return true;
      }
    }

    return this.apply(this.controller.close(id, this.commandContext()));
  }

  open(id: SurfaceId): boolean {
    const surface = this.registry.get(id);
    if (
      surface &&
      isContainedPlacement(surface.placement) &&
      surface.placement.mode === 'minimized'
    ) {
      return this.restore(id) && this.apply(this.controller.open(id));
    }
    return this.apply(this.controller.open(id));
  }

  toggleEditorOpen(): boolean {
    if (this.editorOpen()) return this.close(this.editorId);
    return this.open(this.editorId);
  }

  openEditor(): boolean {
    return this.open(this.editorId);
  }

  externalize(id: SurfaceId, bounds: Rect): boolean {
    if (!this.desktop.available) return false;
    return this.apply(
      this.controller.externalize(id, bounds, { allowNative: true, ...this.commandContext() }),
    );
  }

  returnToWorkspace(id: SurfaceId): boolean {
    if (!this.desktop.available) return false;
    return this.apply(
      this.controller.returnToWorkspace(id, { allowNative: true, ...this.commandContext() }),
    );
  }

  commitFloatingRect(id: SurfaceId, rect: Rect): boolean {
    return this.apply(this.controller.commitFloatingRect(id, rect));
  }

  commitDockSize(id: SurfaceId, size: number): boolean {
    return this.apply(this.controller.commitDockSize(id, size));
  }

  commitMinimizedPoint(id: SurfaceId, point: Point): boolean {
    return this.apply(this.controller.commitMinimizedPoint(id, point));
  }

  /** Electron-only; no-op on web. */
  runExternalize(id: SurfaceId, bounds: Rect): boolean {
    return this.externalize(id, bounds);
  }

  /** Electron-only; no-op on web. */
  runReturn(id: SurfaceId): boolean {
    return this.returnToWorkspace(id);
  }

  private surfaceRecord(id: SurfaceId, kind: 'preview' | 'editor'): SurfaceRecord {
    return this.registry.get(id) ?? createDefaultSurface(kind, { id });
  }

  private readLegacyEditorDockSide(): DockSide {
    return this.preferences.value().editorWindow.dockSide;
  }
}
