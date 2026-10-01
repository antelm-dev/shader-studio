import { describe, expect, it } from 'vitest';

import {
  activePostProcessingCount,
  addPostProcessingEffect,
  canAddPostProcessingEffect,
  createBloomEffect,
  createCustomEffect,
  createVignetteEffect,
  duplicatePostProcessingEffect,
  findPostProcessingEffect,
  hasActivePostProcessing,
  isCustomEffectRunnable,
  movePostProcessingEffect,
  removePostProcessingEffect,
  reorderPostProcessingEffect,
  resetPostProcessingEffect,
  setPostProcessingEffectEnabled,
  updatePostProcessingEffect,
  withPostProcessingEnabled,
  type CustomEffect,
  type RenderSettings,
  type VignetteEffect,
} from './render';
import { LIMITS } from '../validate/limits';

function render(
  effects: RenderSettings['postProcessing']['effects'],
  enabled = true,
): RenderSettings {
  return { postProcessing: { enabled, effects } };
}

const ids = (r: RenderSettings) => r.postProcessing.effects.map((effect) => effect.instanceId);

/** Two Vignettes — what Phase 1 could not express — plus a Bloom. */
function twoVignettes(): RenderSettings {
  return render([
    createVignetteEffect({ enabled: true, instanceId: 'v1', intensity: 0.1 }),
    createBloomEffect({ enabled: true, instanceId: 'b' }),
    createVignetteEffect({ enabled: false, instanceId: 'v2', intensity: 0.9 }),
  ]);
}

describe('effect factories', () => {
  it('give a legacy chain the type as its id, and a custom effect a pass-through v1 definition', () => {
    expect(createVignetteEffect()).toEqual({
      type: 'vignette',
      instanceId: 'vignette',
      enabled: false,
      settings: { intensity: 0.4, softness: 0.5, roundness: 1 },
    });
    const custom = createCustomEffect({
      controls: [{ key: 'amount', type: 'number', default: 0.5, min: 0, max: 1 }],
    });
    expect(custom.definition.apiVersion).toBe(1);
    expect(custom.definition.source).toContain('vec4 effect(vec4 color, vec2 uv)');
    expect(custom.values).toEqual({ amount: 0.5 });
    expect(isCustomEffectRunnable(custom)).toBe(true);
    expect(
      isCustomEffectRunnable({ ...custom, definition: { ...custom.definition, apiVersion: 2 } }),
    ).toBe(false);
  });
});

describe('hasActivePostProcessing / activePostProcessingCount', () => {
  it('count only enabled effects, and none while the master switch is off', () => {
    expect(hasActivePostProcessing(render([]))).toBe(false);
    expect(activePostProcessingCount(twoVignettes())).toBe(2);
    expect(activePostProcessingCount(withPostProcessingEnabled(twoVignettes(), false))).toBe(0);
  });
});

describe('withPostProcessingEnabled', () => {
  it('flips only the master switch, touching neither effects nor their order', () => {
    const r = twoVignettes();
    const next = withPostProcessingEnabled(r, false);
    expect(next.postProcessing.enabled).toBe(false);
    expect(next.postProcessing.effects).toBe(r.postProcessing.effects);
  });
});

describe('addPostProcessingEffect', () => {
  it('appends a fresh enabled instance with a new id, even when the type is present', () => {
    const next = addPostProcessingEffect(twoVignettes(), 'vignette');
    const added = next.postProcessing.effects[3] as VignetteEffect;
    expect(added).toMatchObject({ type: 'vignette', enabled: true });
    expect(added.instanceId).toMatch(/^vignette-[a-z0-9]+$/);
    expect(new Set(ids(next)).size).toBe(4);
  });

  it('re-ids an effect it is given, so a copied effect never clashes', () => {
    const custom = createCustomEffect({ instanceId: 'v1', name: 'Grain' });
    const next = addPostProcessingEffect(twoVignettes(), custom);
    const added = next.postProcessing.effects[3] as CustomEffect;
    expect(added.definition.name).toBe('Grain');
    expect(added.instanceId).not.toBe('v1');
  });
});

describe('the chain limit', () => {
  it('adds and duplicates nothing once the chain holds LIMITS.postProcessingEffectCount effects', () => {
    const full = render(
      Array.from({ length: LIMITS.postProcessingEffectCount }, (_, i) =>
        createBloomEffect({ instanceId: `b${i}` }),
      ),
    );
    expect(canAddPostProcessingEffect(full)).toBe(false);
    expect(addPostProcessingEffect(full, 'vignette')).toBe(full);
    expect(duplicatePostProcessingEffect(full, 'b0')).toBe(full);
    expect(canAddPostProcessingEffect(removePostProcessingEffect(full, 'b0'))).toBe(true);
  });
});

describe('duplicatePostProcessingEffect', () => {
  it('inserts a deep copy right after the original, under a new id', () => {
    const custom = createCustomEffect({
      instanceId: 'c',
      controls: [{ key: 'k', type: 'boolean', default: false }],
    });
    const r = render([custom, createBloomEffect({ instanceId: 'b' })]);
    const next = duplicatePostProcessingEffect(r, 'c');
    const [first, copy, last] = next.postProcessing.effects as [
      CustomEffect,
      CustomEffect,
      unknown,
    ];
    expect(copy.instanceId).not.toBe('c');
    expect(copy.definition).toEqual(first.definition);
    expect(copy.definition).not.toBe(first.definition);
    expect(last).toMatchObject({ instanceId: 'b' });
  });

  it('is a no-op for an unknown id', () => {
    const r = twoVignettes();
    expect(duplicatePostProcessingEffect(r, 'nope')).toBe(r);
  });
});

describe('instance-targeted helpers', () => {
  it('update, toggle, reset and remove only the instance named', () => {
    let r = updatePostProcessingEffect<VignetteEffect>(twoVignettes(), 'v2', (effect) => ({
      ...effect,
      settings: { ...effect.settings, softness: 0.1 },
    }));
    expect((findPostProcessingEffect(r, 'v2') as VignetteEffect).settings.softness).toBe(0.1);
    expect((findPostProcessingEffect(r, 'v1') as VignetteEffect).settings.softness).toBe(0.5);

    r = setPostProcessingEffectEnabled(r, 'v2', true);
    expect(findPostProcessingEffect(r, 'v2')?.enabled).toBe(true);
    expect(findPostProcessingEffect(r, 'v1')?.enabled).toBe(true);

    r = resetPostProcessingEffect(r, 'v1');
    expect((findPostProcessingEffect(r, 'v1') as VignetteEffect).settings.intensity).toBe(0.4);
    expect((findPostProcessingEffect(r, 'v2') as VignetteEffect).settings.intensity).toBe(0.9);

    r = removePostProcessingEffect(r, 'v1');
    expect(ids(r)).toEqual(['b', 'v2']);
  });

  it('cannot change an instance id or type through an update', () => {
    const r = updatePostProcessingEffect(twoVignettes(), 'v1', (effect) => ({
      ...effect,
      instanceId: 'b',
    }));
    expect(ids(r)).toEqual(['v1', 'b', 'v2']);
  });

  it('resets a custom effect to its control defaults without touching its code', () => {
    const custom = createCustomEffect({
      instanceId: 'c',
      source: 'vec4 effect(vec4 c, vec2 uv) { return c * u_gain; }',
      controls: [{ key: 'gain', type: 'number', default: 1, min: 0, max: 2 }],
      values: { gain: 2 },
    });
    const next = resetPostProcessingEffect(render([custom]), 'c');
    const reset = next.postProcessing.effects[0] as CustomEffect;
    expect(reset.values).toEqual({ gain: 1 });
    expect(reset.definition.source).toBe(custom.definition.source);
  });

  it('never mutates the render it is given', () => {
    const r = twoVignettes();
    const clone = structuredClone(r);
    setPostProcessingEffectEnabled(r, 'v1', false);
    resetPostProcessingEffect(r, 'v2');
    movePostProcessingEffect(r, 'v1', 'down');
    expect(r).toEqual(clone);
  });
});

describe('movePostProcessingEffect', () => {
  it('swaps one instance with its neighbor, telling duplicates apart', () => {
    expect(ids(movePostProcessingEffect(twoVignettes(), 'v2', 'up'))).toEqual(['v1', 'v2', 'b']);
    expect(ids(movePostProcessingEffect(twoVignettes(), 'v1', 'down'))).toEqual(['b', 'v1', 'v2']);
  });

  it('is a no-op at either end, or for an unknown id', () => {
    const r = twoVignettes();
    expect(movePostProcessingEffect(r, 'v1', 'up')).toBe(r);
    expect(movePostProcessingEffect(r, 'v2', 'down')).toBe(r);
    expect(movePostProcessingEffect(r, 'nope', 'up')).toBe(r);
  });
});

describe('reorderPostProcessingEffect', () => {
  it('moves one instance before another, or to the end', () => {
    expect(ids(reorderPostProcessingEffect(twoVignettes(), 'v2', 'v1'))).toEqual(['v2', 'v1', 'b']);
    expect(ids(reorderPostProcessingEffect(twoVignettes(), 'v1', null))).toEqual(['b', 'v2', 'v1']);
  });

  it('is a no-op onto itself or with an unknown id', () => {
    const r = twoVignettes();
    expect(reorderPostProcessingEffect(r, 'v1', 'v1')).toBe(r);
    expect(reorderPostProcessingEffect(r, 'v1', 'nope')).toBe(r);
    expect(reorderPostProcessingEffect(r, 'nope', 'v1')).toBe(r);
  });
});
