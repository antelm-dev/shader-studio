import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_EDITOR_WINDOW } from '@shader-studio/shared/editor-prefs';
import {
  COMPACT_VIEWPORT_WIDTH,
  DEFAULT_EDITOR_GROUP_ID,
  WELL_KNOWN_SURFACE_IDS,
  editorSurfaceId,
  isContainedPlacement,
  migrateLayoutFromPreferences,
} from '@shader-studio/shared/surfaces';
import { DEFAULT_PREVIEW_WINDOW } from '@shader-studio/shared/preview-prefs';
import { Preferences, type WorkspacePreferences } from '../prefs/preferences';
import { SurfaceController } from './surface-controller';
import { SurfaceLayoutService } from './surface-layout';
import { SurfaceRegistry } from './surface-registry';
import { projectSurfaceFrame } from './surface-frame';

class FakePreferences implements Partial<Preferences> {
  private readonly state = signal<Partial<WorkspacePreferences>>({
    editorOpen: true,
    editorWindow: DEFAULT_EDITOR_WINDOW,
    previewWindow: DEFAULT_PREVIEW_WINDOW,
    surfacesLayout: migrateLayoutFromPreferences({
      editorOpen: true,
      editorWindow: DEFAULT_EDITOR_WINDOW,
      previewWindow: DEFAULT_PREVIEW_WINDOW,
    }),
  });

  readonly value = this.state.asReadonly() as Preferences['value'];

  patch(patch: Partial<WorkspacePreferences>): void {
    this.state.update((current) => ({ ...current, ...patch }));
  }
}

describe('SurfaceLayoutService characterization', () => {
  let layout: SurfaceLayoutService;
  let registry: SurfaceRegistry;
  let preferences: FakePreferences;

  const viewport = { width: 1200, height: 800 };
  const editorId = editorSurfaceId(DEFAULT_EDITOR_GROUP_ID);
  const previewId = WELL_KNOWN_SURFACE_IDS.preview;

  beforeEach(() => {
    preferences = new FakePreferences();
    TestBed.configureTestingModule({
      providers: [
        SurfaceRegistry,
        SurfaceController,
        SurfaceLayoutService,
        { provide: Preferences, useValue: preferences },
      ],
    });
    registry = TestBed.inject(SurfaceRegistry);
    layout = TestBed.inject(SurfaceLayoutService);
    registry.setViewport(viewport);
    layout.hydrateFromPreferences();
  });

  const editorPlacement = () => layout.editor().placement;
  const previewPlacement = () => layout.preview().placement;

  describe('editor', () => {
    it('detaches into a floating window (contained float, not native)', () => {
      layout.float(editorId);
      const placement = editorPlacement();
      expect(isContainedPlacement(placement) && placement.mode).toBe('floating');
    });

    it('restores a maximized floating editor back to floating', () => {
      layout.float(editorId);
      layout.maximize(editorId);
      layout.restore(editorId);
      const placement = editorPlacement();
      expect(isContainedPlacement(placement) && placement.mode).toBe('floating');
    });

    it('closes by setting open=false without discarding placement', () => {
      layout.float(editorId);
      const before = structuredClone(layout.editor().placement);
      layout.close(editorId);
      expect(layout.editorOpen()).toBe(false);
      expect(layout.editor().placement).toEqual(before);
    });

    it('openEditor restores from minimized so the editor is visible', () => {
      layout.float(editorId);
      layout.minimize(editorId);
      layout.close(editorId);
      layout.openEditor();
      const placement = editorPlacement();
      expect(layout.editorOpen()).toBe(true);
      expect(isContainedPlacement(placement) && placement.mode).toBe('floating');
    });

    it('renders floating as docked on compact viewport without rewriting stored mode', () => {
      layout.float(editorId);
      registry.setViewport({ width: COMPACT_VIEWPORT_WIDTH - 1, height: 800 });
      const projected = projectSurfaceFrame(layout.editor(), registry.viewport());
      expect(projected.mode).toBe('docked');
      const stored = editorPlacement();
      expect(isContainedPlacement(stored) && stored.mode).toBe('floating');
    });
  });

  describe('preview', () => {
    it('starts on the stage by default', () => {
      const placement = previewPlacement();
      expect(isContainedPlacement(placement) && placement.mode).toBe('stage');
    });

    it('detaches into a floating window', () => {
      layout.float(previewId);
      const placement = previewPlacement();
      expect(isContainedPlacement(placement) && placement.mode).toBe('floating');
    });

    it('returns to the stage', () => {
      layout.float(previewId);
      layout.showOnStage(previewId);
      const placement = previewPlacement();
      expect(isContainedPlacement(placement) && placement.mode).toBe('stage');
    });

    it('restores a maximized floating preview back to floating', () => {
      layout.float(previewId);
      layout.maximize(previewId);
      layout.restore(previewId);
      const placement = previewPlacement();
      expect(isContainedPlacement(placement) && placement.mode).toBe('floating');
    });
  });

  describe('z-order', () => {
    it('brings the most recently activated stacked surface to the foreground', () => {
      layout.float(editorId);
      layout.float(previewId);
      layout.activate(editorId);
      expect(registry.foreground()).toBe(editorId);
      layout.activate(previewId);
      expect(registry.foreground()).toBe(previewId);
      expect(registry.zIndex(previewId)!).toBeGreaterThan(registry.zIndex(editorId)!);
    });
  });
});
