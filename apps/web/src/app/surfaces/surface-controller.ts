/**
 * Command facade over pure surface transitions + the registry.
 *
 * Content wrappers call these methods instead of reaching into Preferences or
 * legacy EditorWindow/PreviewWindow machines. Persistence is the caller's job:
 * listen for successful updates (or poll registry.snapshot()) and write layout
 * prefs — never from pointermove.
 *
 * SSR-safe: no browser globals.
 */

import { Injectable, inject } from '@angular/core';

import type { Point, Rect, Size } from '@shader-studio/shared/geometry';
import {
  closeSurface,
  dock,
  externalize,
  floatSurface,
  maximize,
  minimize,
  move,
  openSurface,
  resetGeometry,
  resize,
  restore,
  returnToWorkspace,
  showOnStage,
  type DockSide,
  type SurfaceId,
  type SurfaceRecord,
  type TransitionContext,
  type TransitionResult,
  type TransitionSuccess,
} from '@shader-studio/shared/surfaces';

import { SurfaceRegistry } from './surface-registry';

export type SurfaceCommandResult = TransitionResult & {
  readonly previewPlacementApplied?: boolean;
};

export interface SurfaceControllerOptions {
  /** Electron only. Web must leave false. */
  readonly allowNative?: boolean;
  readonly workArea?: Size;
  readonly displayId?: string;
  /**
   * Override remaining editor groups after a prospective close.
   * Defaults to registry.openEditorGroupCount() - 1.
   */
  readonly remainingEditorGroups?: number;
}

@Injectable({ providedIn: 'root' })
export class SurfaceController {
  private readonly registry = inject(SurfaceRegistry);

  context(extra: SurfaceControllerOptions = {}): TransitionContext {
    return {
      viewport: this.registry.viewport(),
      workArea: extra.workArea,
      displayId: extra.displayId,
      allowNative: extra.allowNative ?? false,
      remainingEditorGroups: extra.remainingEditorGroups,
    };
  }

  showOnStage(id: SurfaceId): SurfaceCommandResult {
    return this.apply(id, (surface) => showOnStage(surface));
  }

  dock(id: SurfaceId, side?: DockSide, size?: number): SurfaceCommandResult {
    return this.apply(id, (surface, ctx) => dock(surface, side, size, ctx));
  }

  float(id: SurfaceId, rect?: Rect): SurfaceCommandResult {
    return this.apply(id, (surface, ctx) => floatSurface(surface, rect, ctx));
  }

  maximize(id: SurfaceId): SurfaceCommandResult {
    return this.apply(id, (surface, ctx) => maximize(surface, ctx), { activate: true });
  }

  minimize(id: SurfaceId, point?: Point): SurfaceCommandResult {
    return this.apply(id, (surface, ctx) => minimize(surface, point, ctx), { activate: true });
  }

  restore(id: SurfaceId): SurfaceCommandResult {
    return this.apply(id, (surface, ctx) => restore(surface, ctx), { activate: true });
  }

  externalize(
    id: SurfaceId,
    bounds: Rect,
    options: SurfaceControllerOptions = {},
  ): SurfaceCommandResult {
    return this.apply(id, (surface, ctx) => externalize(surface, bounds, ctx), { options });
  }

  returnToWorkspace(id: SurfaceId, options: SurfaceControllerOptions = {}): SurfaceCommandResult {
    return this.apply(id, (surface, ctx) => returnToWorkspace(surface, ctx), {
      options,
      activate: true,
    });
  }

  move(id: SurfaceId, position: Point): SurfaceCommandResult {
    return this.apply(id, (surface, ctx) => move(surface, position, ctx));
  }

  resize(id: SurfaceId, next: { rect?: Rect; size?: number; bounds?: Rect }): SurfaceCommandResult {
    return this.apply(id, (surface, ctx) => resize(surface, next, ctx));
  }

  /** Commit a floating rect after a gesture ends. */
  commitFloatingRect(id: SurfaceId, rect: Rect): SurfaceCommandResult {
    return this.resize(id, { rect });
  }

  /** Commit a dock size after a gesture ends. */
  commitDockSize(id: SurfaceId, size: number): SurfaceCommandResult {
    return this.resize(id, { size });
  }

  /** Commit a minimized point after a gesture ends. */
  commitMinimizedPoint(id: SurfaceId, point: Point): SurfaceCommandResult {
    return this.apply(id, (surface, ctx) => minimize(surface, point, ctx));
  }

  resetGeometry(id: SurfaceId): SurfaceCommandResult {
    return this.apply(id, (surface, ctx) => resetGeometry(surface, ctx));
  }

  close(id: SurfaceId, options: SurfaceControllerOptions = {}): SurfaceCommandResult {
    const surface = this.registry.get(id);
    if (!surface) {
      return { ok: false, code: 'invalid-argument', message: `unknown surface ${id}` };
    }

    const remaining =
      options.remainingEditorGroups ??
      (surface.kind === 'editor'
        ? Math.max(0, this.registry.openEditorGroupCount() - 1)
        : undefined);

    return this.apply(
      id,
      (record, ctx) => closeSurface(record, { ...ctx, remainingEditorGroups: remaining }),
      { options: { ...options, remainingEditorGroups: remaining } },
    );
  }

  open(id: SurfaceId): SurfaceCommandResult {
    return this.apply(id, (surface) => openSurface(surface), { activate: true });
  }

  activate(id: SurfaceId): void {
    this.registry.activate(id);
  }

  private apply(
    id: SurfaceId,
    transition: (surface: SurfaceRecord, ctx: TransitionContext) => TransitionResult,
    opts: { options?: SurfaceControllerOptions; activate?: boolean } = {},
  ): SurfaceCommandResult {
    const surface = this.registry.get(id);
    if (!surface) {
      return { ok: false, code: 'invalid-argument', message: `unknown surface ${id}` };
    }

    const ctx = this.context(opts.options ?? {});
    const result = transition(surface, ctx);
    if (!result.ok) return result;

    this.commitSuccess(result, opts.activate === true);
    return result;
  }

  private commitSuccess(result: TransitionSuccess, activate: boolean): void {
    this.registry.upsert(result.surface);

    if (result.previewPlacement) {
      // live-preview-output return: thin adapter until Agent 07 unifies.
      const preview = this.registry.surfaces().find((s) => s.kind === 'preview');
      if (preview) {
        this.registry.upsert({
          ...preview,
          open: true,
          placement: result.previewPlacement,
        });
      }
    }

    if (activate || this.shouldAutoActivate(result.surface)) {
      this.registry.activate(result.surface.id);
    }
  }

  private shouldAutoActivate(surface: SurfaceRecord): boolean {
    if (!surface.open) return false;
    if (surface.placement.host !== 'contained') return false;
    const mode = surface.placement.mode;
    return mode === 'floating' || mode === 'maximized' || mode === 'minimized';
  }
}
