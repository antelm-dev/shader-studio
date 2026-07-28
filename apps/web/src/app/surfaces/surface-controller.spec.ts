import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { createDefaultSurface } from '@shader-studio/shared/surfaces';

import { SurfaceController } from './surface-controller';
import { SurfaceRegistry } from './surface-registry';

describe('SurfaceController', () => {
  let registry: SurfaceRegistry;
  let controller: SurfaceController;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    registry = TestBed.inject(SurfaceRegistry);
    controller = TestBed.inject(SurfaceController);
  });

  it('floats, maximizes, minimizes, and restores through pure transitions', () => {
    const preview = createDefaultSurface('preview', {
      placement: { host: 'contained', mode: 'stage' },
    });
    registry.upsert(preview);
    registry.setViewport({ width: 1200, height: 800 });

    expect(controller.float(preview.id).ok).toBe(true);
    expect(registry.get(preview.id)?.placement).toMatchObject({ mode: 'floating' });

    expect(controller.maximize(preview.id).ok).toBe(true);
    expect(registry.get(preview.id)?.placement).toMatchObject({ mode: 'maximized' });

    expect(controller.minimize(preview.id).ok).toBe(true);
    const minimized = registry.get(preview.id)?.placement;
    expect(minimized).toMatchObject({ mode: 'minimized', restore: { mode: 'floating' } });

    expect(controller.restore(preview.id).ok).toBe(true);
    expect(registry.get(preview.id)?.placement).toMatchObject({ mode: 'floating' });
  });

  it('rejects closing the last editor group', () => {
    const editor = createDefaultSurface('editor');
    registry.upsert(editor);

    const result = controller.close(editor.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('last-editor-group');
    expect(registry.get(editor.id)?.open).toBe(true);
  });

  it('rejects externalize when allowNative is false', () => {
    const preview = createDefaultSurface('preview', {
      placement: {
        host: 'contained',
        mode: 'floating',
        rect: { x: 10, y: 10, width: 400, height: 300 },
      },
    });
    registry.upsert(preview);

    const result = controller.externalize(preview.id, { x: 0, y: 0, width: 800, height: 600 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('externalize-unavailable');
  });

  it('commits floating geometry only through resize, not viewport updates', () => {
    const preview = createDefaultSurface('preview', {
      placement: {
        host: 'contained',
        mode: 'floating',
        rect: { x: 100, y: 100, width: 400, height: 300 },
      },
    });
    registry.upsert(preview);
    registry.setViewport({ width: 200, height: 200 });

    const before = registry.get(preview.id)?.placement;
    expect(before).toMatchObject({
      mode: 'floating',
      rect: { x: 100, y: 100, width: 400, height: 300 },
    });

    registry.setViewport({ width: 1200, height: 800 });
    expect(
      controller.commitFloatingRect(preview.id, { x: 8, y: 8, width: 360, height: 240 }).ok,
    ).toBe(true);
    expect(registry.get(preview.id)?.placement).toMatchObject({
      mode: 'floating',
      rect: { x: 8, y: 8, width: 360, height: 240 },
    });
  });

  it('activates stacked surfaces after float', () => {
    const preview = createDefaultSurface('preview');
    registry.upsert(preview);
    registry.setViewport({ width: 1000, height: 700 });

    controller.float(preview.id);
    expect(registry.foreground()).toBe(preview.id);
  });
});
