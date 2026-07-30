/**
 * The render contract: what happens to a frame after the shader itself runs.
 *
 * `RenderSettings.postProcessing` is an ordered chain of effects applied after
 * the final Image pass (never to Buffer A-D). Order is an effect's identity —
 * there is no persistent instance id yet — and Phase 1 permits at most one
 * effect per `type`. `PostProcessingEffect` is a discriminated union so a later
 * task can add another effect type without touching anything that already
 * switches on `type`.
 */

export interface BloomSettings {
  strength: number;
  radius: number;
  threshold: number;
}

export const DEFAULT_BLOOM: BloomSettings = {
  strength: 0.3,
  radius: 0.5,
  threshold: 0.85,
};

export interface BloomEffect {
  type: 'bloom';
  enabled: boolean;
  settings: BloomSettings;
}

export interface VignetteSettings {
  intensity: number;
  softness: number;
  roundness: number;
}

export const DEFAULT_VIGNETTE: VignetteSettings = {
  intensity: 0.4,
  softness: 0.5,
  roundness: 1,
};

export interface VignetteEffect {
  type: 'vignette';
  enabled: boolean;
  settings: VignetteSettings;
}

/** Phase 2 has two members. Extend this union, not a new sibling field, for the next effect. */
export type PostProcessingEffect = BloomEffect | VignetteEffect;
export type PostProcessingEffectType = PostProcessingEffect['type'];

/** Every effect type the rack can add, in the order its add menu offers them. */
export const POST_PROCESSING_EFFECT_TYPES: readonly PostProcessingEffectType[] = [
  'bloom',
  'vignette',
];

export interface PostProcessingChain {
  /** Master switch. Off always takes the direct-render path, whatever the effects say. */
  enabled: boolean;
  /** At most one instance per `type` in Phase 1. Order is significant and is each effect's identity. */
  effects: PostProcessingEffect[];
}

export interface RenderSettings {
  postProcessing: PostProcessingChain;
}

export function createBloomEffect(
  overrides: Partial<BloomSettings> & { enabled?: boolean } = {},
): BloomEffect {
  const { enabled, ...settings } = overrides;
  return {
    type: 'bloom',
    enabled: enabled ?? false,
    settings: { ...DEFAULT_BLOOM, ...settings },
  };
}

export const DEFAULT_RENDER: RenderSettings = {
  postProcessing: { enabled: true, effects: [createBloomEffect()] },
};

/** The chain's Bloom effect, or a disabled default if the chain has none. */
export function getBloomEffect(render: RenderSettings): BloomEffect {
  return (
    render.postProcessing.effects.find(
      (effect): effect is BloomEffect => effect.type === 'bloom',
    ) ?? createBloomEffect()
  );
}

/**
 * `render` with its Bloom effect replaced (or appended if the chain has none),
 * preserving the master switch, the rest of the chain and the Bloom effect's
 * position. Never mutates `render`.
 */
export function withBloomEffect(
  render: RenderSettings,
  patch: Partial<BloomSettings> & { enabled: boolean },
): RenderSettings {
  const { enabled, ...settingsPatch } = patch;
  const bloom: BloomEffect = {
    type: 'bloom',
    enabled,
    settings: { ...getBloomEffect(render).settings, ...settingsPatch },
  };
  const { effects } = render.postProcessing;
  const next = effects.some((effect) => effect.type === 'bloom')
    ? effects.map((effect) => (effect.type === 'bloom' ? bloom : effect))
    : [...effects, bloom];
  return { postProcessing: { enabled: render.postProcessing.enabled, effects: next } };
}

export function createVignetteEffect(
  overrides: Partial<VignetteSettings> & { enabled?: boolean } = {},
): VignetteEffect {
  const { enabled, ...settings } = overrides;
  return {
    type: 'vignette',
    enabled: enabled ?? false,
    settings: { ...DEFAULT_VIGNETTE, ...settings },
  };
}

/** The chain's Vignette effect, or a disabled default if the chain has none. */
export function getVignetteEffect(render: RenderSettings): VignetteEffect {
  return (
    render.postProcessing.effects.find(
      (effect): effect is VignetteEffect => effect.type === 'vignette',
    ) ?? createVignetteEffect()
  );
}

/**
 * `render` with its Vignette effect replaced (or appended if the chain has
 * none), preserving the master switch, the rest of the chain and the
 * Vignette effect's position. Never mutates `render`.
 */
export function withVignetteEffect(
  render: RenderSettings,
  patch: Partial<VignetteSettings> & { enabled: boolean },
): RenderSettings {
  const { enabled, ...settingsPatch } = patch;
  const vignette: VignetteEffect = {
    type: 'vignette',
    enabled,
    settings: { ...getVignetteEffect(render).settings, ...settingsPatch },
  };
  const { effects } = render.postProcessing;
  const next = effects.some((effect) => effect.type === 'vignette')
    ? effects.map((effect) => (effect.type === 'vignette' ? vignette : effect))
    : [...effects, vignette];
  return { postProcessing: { enabled: render.postProcessing.enabled, effects: next } };
}

/** A fresh, enabled default instance of `type` — what the rack's Add menu inserts. */
function createDefaultEffect(type: PostProcessingEffectType): PostProcessingEffect {
  switch (type) {
    case 'bloom':
      return createBloomEffect({ enabled: true });
    case 'vignette':
      return createVignetteEffect({ enabled: true });
  }
}

/**
 * Whether the chain would actually alter the frame right now: the master
 * switch is on and at least one effect in it is enabled. This is the one
 * point that decides "is post-processing active" — callers that only need a
 * yes/no (the Wallpaper export warning, say) should use this rather than
 * re-deriving it from `postProcessing.enabled` and each effect separately.
 */
export function hasActivePostProcessing(render: RenderSettings): boolean {
  return render.postProcessing.enabled && render.postProcessing.effects.some((e) => e.enabled);
}

/** The chain's master switch only — every effect and its order are untouched. */
export function withPostProcessingEnabled(
  render: RenderSettings,
  enabled: boolean,
): RenderSettings {
  return { postProcessing: { enabled, effects: render.postProcessing.effects } };
}

/**
 * Appends a fresh, enabled default instance of `type` to the chain. A no-op
 * if the chain already has one — Phase 1 permits at most one instance per
 * type, and the rack's Add menu is expected to disable already-present types
 * rather than rely on this silently ignoring the request.
 */
export function addPostProcessingEffect(
  render: RenderSettings,
  type: PostProcessingEffectType,
): RenderSettings {
  if (render.postProcessing.effects.some((effect) => effect.type === type)) return render;
  return {
    postProcessing: {
      enabled: render.postProcessing.enabled,
      effects: [...render.postProcessing.effects, createDefaultEffect(type)],
    },
  };
}

/** Drops `type` from the chain entirely. Not the same as disabling it. */
export function removePostProcessingEffect(
  render: RenderSettings,
  type: PostProcessingEffectType,
): RenderSettings {
  return {
    postProcessing: {
      enabled: render.postProcessing.enabled,
      effects: render.postProcessing.effects.filter((effect) => effect.type !== type),
    },
  };
}

/** Toggles one effect's own switch, leaving its settings and position untouched. */
export function setPostProcessingEffectEnabled(
  render: RenderSettings,
  type: PostProcessingEffectType,
  enabled: boolean,
): RenderSettings {
  return {
    postProcessing: {
      enabled: render.postProcessing.enabled,
      effects: render.postProcessing.effects.map((effect) =>
        effect.type === type ? { ...effect, enabled } : effect,
      ),
    },
  };
}

/** Resets one effect's settings to its type default, keeping its enabled state and position. */
export function resetPostProcessingEffect(
  render: RenderSettings,
  type: PostProcessingEffectType,
): RenderSettings {
  return {
    postProcessing: {
      enabled: render.postProcessing.enabled,
      effects: render.postProcessing.effects.map((effect) =>
        effect.type === type ? { ...createDefaultEffect(type), enabled: effect.enabled } : effect,
      ),
    },
  };
}

/** Swaps `type` with its neighbor toward `direction`. A no-op at either end of the chain, or if `type` is absent. */
export function movePostProcessingEffect(
  render: RenderSettings,
  type: PostProcessingEffectType,
  direction: 'up' | 'down',
): RenderSettings {
  const { effects } = render.postProcessing;
  const index = effects.findIndex((effect) => effect.type === type);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= effects.length) return render;

  const next = [...effects];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return { postProcessing: { enabled: render.postProcessing.enabled, effects: next } };
}
