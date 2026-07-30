import { describe, expect, it } from 'vitest';

import { CAPABILITY_PRESETS, allowsDockSide, capabilitiesFor, can } from './capabilities';
import { createDefaultSurface } from './sanitize';
import {
  closeSurface,
  dock,
  externalize,
  floatSurface,
  maximize,
  minimize,
  returnToWorkspace,
  showOnStage,
} from './transitions';
import type { SurfaceKind } from './types';
import { SURFACE_KINDS } from './types';

type CapKey =
  | 'stage'
  | 'dock'
  | 'float'
  | 'maximize'
  | 'minimize'
  | 'externalize'
  | 'return'
  | 'close';

const TRANSITION_CAPS: readonly CapKey[] = [
  'stage',
  'dock',
  'float',
  'maximize',
  'minimize',
  'externalize',
  'return',
  'close',
];

function tryTransition(kind: SurfaceKind, cap: CapKey) {
  const surface = createDefaultSurface(kind, {
    open: true,
    placement:
      kind === 'live-preview-output'
        ? { host: 'native', bounds: { x: 10, y: 10, width: 640, height: 480 } }
        : createDefaultSurface(kind).placement,
  });

  switch (cap) {
    case 'stage':
      return showOnStage(surface);
    case 'dock':
      return dock(surface);
    case 'float':
      return floatSurface(surface);
    case 'maximize':
      return maximize(surface);
    case 'minimize':
      return minimize(surface);
    case 'externalize':
      return externalize(
        surface.placement.host === 'native' ? createDefaultSurface('preview') : surface,
        { x: 0, y: 0, width: 800, height: 600 },
        { allowNative: true },
      );
    case 'return':
      if (surface.placement.host !== 'native') {
        const ext = externalize(
          surface,
          { x: 0, y: 0, width: 800, height: 600 },
          {
            allowNative: true,
          },
        );
        if (!ext.ok) return ext;
        return returnToWorkspace(ext.surface);
      }
      return returnToWorkspace(surface);
    case 'close':
      return closeSurface(surface, { remainingEditorGroups: kind === 'editor' ? 2 : 1 });
  }
}

describe('capability presets', () => {
  it('covers every surface kind', () => {
    for (const kind of SURFACE_KINDS) {
      expect(capabilitiesFor(kind)).toBe(CAPABILITY_PRESETS[kind]);
    }
  });

  it('keeps rail float disabled for MVP (coordinator decision)', () => {
    expect(CAPABILITY_PRESETS['shader-browser'].float).toBe(false);
    expect(CAPABILITY_PRESETS['bottom-panel'].float).toBe(false);
  });

  it('enables inspector float in phase 1 without widening its dock side', () => {
    const caps = CAPABILITY_PRESETS.inspector;
    expect(caps.float).toBe(true);
    expect(caps.dock).toBe(true);
    expect(caps.allowedDockSides).toEqual(['right']);
  });

  it('marks preview as singleton GPU host that cannot close or dock', () => {
    const caps = CAPABILITY_PRESETS.preview;
    expect(caps.close).toBe(false);
    expect(caps.dock).toBe(false);
    expect(caps.stage).toBe(true);
    expect(caps.singleton).toBe(true);
    expect(caps.hostsGpuPreview).toBe(true);
    expect(caps.multiInstance).toBe(false);
  });

  it('marks editor as multi-instance writable owner that cannot stage', () => {
    const caps = CAPABILITY_PRESETS.editor;
    expect(caps.stage).toBe(false);
    expect(caps.multiInstance).toBe(true);
    expect(caps.singleton).toBe(false);
    expect(caps.ownsWritableDocs).toBe(true);
    expect(caps.close).toBe(true);
  });

  it.each(
    SURFACE_KINDS.flatMap((kind) =>
      TRANSITION_CAPS.map((cap) => ({ kind, cap, allowed: can(kind, cap) })),
    ),
  )('$kind $cap → allowed=$allowed matches transition result', ({ kind, cap, allowed }) => {
    // externalize against live-preview-output uses preview stand-in above when
    // the subject is already native; skip that mismatch by testing capability only
    // for live-preview-output externalize.
    if (kind === 'live-preview-output' && cap === 'externalize') {
      expect(allowed).toBe(false);
      return;
    }

    const result = tryTransition(kind, cap);
    if (allowed) {
      // return from a kind that cannot externalize (and is not already native)
      // still needs a native starting point — live-preview-output is native.
      if (cap === 'return' && !can(kind, 'externalize') && kind !== 'live-preview-output') {
        expect(allowed).toBe(false);
        return;
      }
      expect(result.ok).toBe(true);
    } else {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('capability-denied');
      }
    }
  });

  it('restricts dock sides per kind', () => {
    expect(allowsDockSide('editor', 'bottom')).toBe(true);
    expect(allowsDockSide('editor', 'top')).toBe(false);
    expect(allowsDockSide('inspector', 'right')).toBe(true);
    expect(allowsDockSide('inspector', 'left')).toBe(false);
    expect(allowsDockSide('shader-browser', 'left')).toBe(true);
    expect(allowsDockSide('bottom-panel', 'bottom')).toBe(true);
    expect(allowsDockSide('preview', 'bottom')).toBe(false);
  });
});
