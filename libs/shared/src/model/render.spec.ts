import { describe, expect, it } from 'vitest';

import {
  addPostProcessingEffect,
  createBloomEffect,
  createVignetteEffect,
  getVignetteEffect,
  hasActivePostProcessing,
  movePostProcessingEffect,
  removePostProcessingEffect,
  resetPostProcessingEffect,
  setPostProcessingEffectEnabled,
  withPostProcessingEnabled,
  withVignetteEffect,
  type RenderSettings,
} from './render';

function render(
  effects: RenderSettings['postProcessing']['effects'],
  enabled = true,
): RenderSettings {
  return { postProcessing: { enabled, effects } };
}

describe('Vignette effect helpers', () => {
  it('defaults to disabled with the standard settings', () => {
    expect(createVignetteEffect()).toEqual({
      type: 'vignette',
      enabled: false,
      settings: { intensity: 0.4, softness: 0.5, roundness: 1 },
    });
  });

  it('getVignetteEffect returns a disabled default when the chain has none', () => {
    const r = render([createBloomEffect({ enabled: true })]);
    expect(getVignetteEffect(r).enabled).toBe(false);
  });

  it('withVignetteEffect appends when absent, preserving the rest of the chain and the master switch', () => {
    const r = render([createBloomEffect({ enabled: true })], false);
    const next = withVignetteEffect(r, {
      enabled: true,
      intensity: 0.7,
      softness: 0.2,
      roundness: 0.1,
    });

    expect(next.postProcessing.enabled).toBe(false);
    expect(next.postProcessing.effects).toHaveLength(2);
    expect(next.postProcessing.effects[0]?.type).toBe('bloom');
    expect(next.postProcessing.effects[1]).toEqual({
      type: 'vignette',
      enabled: true,
      settings: { intensity: 0.7, softness: 0.2, roundness: 0.1 },
    });
  });

  it('withVignetteEffect replaces in place, keeping position', () => {
    const r = render([
      createVignetteEffect({ enabled: true, intensity: 0.1 }),
      createBloomEffect({ enabled: true }),
    ]);
    const next = withVignetteEffect(r, {
      enabled: false,
      intensity: 0.9,
      softness: 0.5,
      roundness: 1,
    });

    expect(next.postProcessing.effects[0]?.type).toBe('vignette');
    expect(next.postProcessing.effects[0]).toEqual({
      type: 'vignette',
      enabled: false,
      settings: { intensity: 0.9, softness: 0.5, roundness: 1 },
    });
    expect(next.postProcessing.effects[1]?.type).toBe('bloom');
  });

  it('never mutates the render it is given', () => {
    const r = render([createBloomEffect({ enabled: true })]);
    const clone = structuredClone(r);
    withVignetteEffect(r, { enabled: true, intensity: 1, softness: 1, roundness: 1 });
    expect(r).toEqual(clone);
  });
});

describe('hasActivePostProcessing', () => {
  it('is false with an empty chain, master off, or every effect disabled', () => {
    expect(hasActivePostProcessing(render([]))).toBe(false);
    expect(hasActivePostProcessing(render([createBloomEffect({ enabled: true })], false))).toBe(
      false,
    );
    expect(hasActivePostProcessing(render([createBloomEffect({ enabled: false })]))).toBe(false);
  });

  it('is true when the master switch is on and at least one effect is enabled', () => {
    expect(
      hasActivePostProcessing(
        render([createBloomEffect({ enabled: false }), createVignetteEffect({ enabled: true })]),
      ),
    ).toBe(true);
  });
});

describe('withPostProcessingEnabled', () => {
  it('flips only the master switch, touching neither effects nor their order', () => {
    const r = render([
      createBloomEffect({ enabled: true }),
      createVignetteEffect({ enabled: true }),
    ]);
    const next = withPostProcessingEnabled(r, false);
    expect(next.postProcessing.enabled).toBe(false);
    expect(next.postProcessing.effects).toBe(r.postProcessing.effects);
  });
});

describe('addPostProcessingEffect', () => {
  it('appends a fresh, enabled default instance', () => {
    const next = addPostProcessingEffect(render([]), 'vignette');
    expect(next.postProcessing.effects).toEqual([createVignetteEffect({ enabled: true })]);
  });

  it('is a no-op if the chain already has that type', () => {
    const r = render([createVignetteEffect({ enabled: false, intensity: 0.9 })]);
    expect(addPostProcessingEffect(r, 'vignette')).toBe(r);
  });
});

describe('removePostProcessingEffect', () => {
  it('drops the effect entirely rather than disabling it', () => {
    const r = render([
      createBloomEffect({ enabled: true }),
      createVignetteEffect({ enabled: true }),
    ]);
    const next = removePostProcessingEffect(r, 'bloom');
    expect(next.postProcessing.effects).toEqual([createVignetteEffect({ enabled: true })]);
  });

  it('is a no-op if the type is absent', () => {
    const r = render([createVignetteEffect({ enabled: true })]);
    expect(removePostProcessingEffect(r, 'bloom').postProcessing.effects).toEqual(
      r.postProcessing.effects,
    );
  });
});

describe('setPostProcessingEffectEnabled', () => {
  it('toggles one effect without touching its settings or position', () => {
    const r = render([
      createBloomEffect({ enabled: true, strength: 1.5 }),
      createVignetteEffect({ enabled: false }),
    ]);
    const next = setPostProcessingEffectEnabled(r, 'vignette', true);
    expect(next.postProcessing.effects[1]).toEqual(createVignetteEffect({ enabled: true }));
    expect(next.postProcessing.effects[0]).toEqual(
      createBloomEffect({ enabled: true, strength: 1.5 }),
    );
  });
});

describe('resetPostProcessingEffect', () => {
  it('resets settings to type defaults, keeping enabled state and position', () => {
    const r = render([
      createVignetteEffect({ enabled: true, intensity: 0.9, softness: 0.1, roundness: 0 }),
      createBloomEffect({ enabled: true }),
    ]);
    const next = resetPostProcessingEffect(r, 'vignette');
    expect(next.postProcessing.effects[0]).toEqual(createVignetteEffect({ enabled: true }));
    expect(next.postProcessing.effects[1]?.type).toBe('bloom');
  });
});

describe('movePostProcessingEffect', () => {
  it('swaps with the previous neighbor on "up"', () => {
    const r = render([
      createBloomEffect({ enabled: true }),
      createVignetteEffect({ enabled: true }),
    ]);
    const next = movePostProcessingEffect(r, 'vignette', 'up');
    expect(next.postProcessing.effects.map((e) => e.type)).toEqual(['vignette', 'bloom']);
  });

  it('swaps with the next neighbor on "down"', () => {
    const r = render([
      createVignetteEffect({ enabled: true }),
      createBloomEffect({ enabled: true }),
    ]);
    const next = movePostProcessingEffect(r, 'vignette', 'down');
    expect(next.postProcessing.effects.map((e) => e.type)).toEqual(['bloom', 'vignette']);
  });

  it('is a no-op at either end of the chain', () => {
    const r = render([
      createBloomEffect({ enabled: true }),
      createVignetteEffect({ enabled: true }),
    ]);
    expect(movePostProcessingEffect(r, 'bloom', 'up')).toBe(r);
    expect(movePostProcessingEffect(r, 'vignette', 'down')).toBe(r);
  });

  it('is a no-op if the type is absent from the chain', () => {
    const r = render([createBloomEffect({ enabled: true })]);
    expect(movePostProcessingEffect(r, 'vignette', 'up')).toBe(r);
  });
});
