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

/** Phase 1 has exactly one member. Extend this union, not a new sibling field, for the next effect. */
export type PostProcessingEffect = BloomEffect;
export type PostProcessingEffectType = PostProcessingEffect['type'];

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
