/**
 * The render contract: what happens to a frame after the shader itself runs.
 *
 * `RenderSettings.postProcessing` is an ordered chain of effects applied after
 * the final Image pass (never to Buffer A-D). Every effect carries an
 * `instanceId`, unique within its chain, and every chain helper below targets
 * that id — so two instances of one type (two Vignettes, two custom effects)
 * are set, moved, toggled and removed independently.
 *
 * A `custom` effect embeds its whole definition — GLSL, controls — and its
 * own values. It is a copy, never a reference to a library entry or a plugin,
 * so a shader keeps rendering whatever happens to where the effect came from.
 */
import { LIMITS } from '../validate/limits';
import type { ShaderControl, ShaderParams } from './controls';

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
  instanceId: string;
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
  instanceId: string;
  enabled: boolean;
  settings: VignetteSettings;
}

/**
 * The only custom-effect API this app runs. Version 1 is: the author writes
 * `vec4 effect(vec4 color, vec2 uv)`; the app supplies the full-screen vertex
 * stage, samples the previous frame (`tDiffuse` at `vUv`) into `color`, and
 * declares `u_resolution`, `u_time` and one `u_<key>` per control.
 */
export const CUSTOM_EFFECT_API_VERSION = 1;

/** What an author writes when they start a new custom effect: a pass-through. */
export const DEFAULT_CUSTOM_EFFECT_SOURCE = `vec4 effect(vec4 color, vec2 uv) {
  return color;
}
`;

export interface CustomEffectDefinition {
  /**
   * Any positive integer survives validation, so a shader from a newer app
   * keeps its name and code; only `CUSTOM_EFFECT_API_VERSION` is executed
   * (see `isCustomEffectRunnable`).
   */
  apiVersion: number;
  name: string;
  source: string;
  /** Local to this effect: keys never collide with the shader's or another effect's. */
  controls: ShaderControl[];
}

export interface CustomEffect {
  type: 'custom';
  instanceId: string;
  enabled: boolean;
  definition: CustomEffectDefinition;
  values: ShaderParams;
}

export type PostProcessingEffect = BloomEffect | VignetteEffect | CustomEffect;
export type PostProcessingEffectType = PostProcessingEffect['type'];

/** Every effect type the rack can add, in the order its add menu offers them. */
export const POST_PROCESSING_EFFECT_TYPES: readonly PostProcessingEffectType[] = [
  'bloom',
  'vignette',
  'custom',
];

export interface PostProcessingChain {
  /** Master switch. Off always takes the direct-render path, whatever the effects say. */
  enabled: boolean;
  /** Order is significant. `instanceId`s are unique within the chain. */
  effects: PostProcessingEffect[];
}

export interface RenderSettings {
  postProcessing: PostProcessingChain;
}

/**
 * A chain predating instance ids held at most one effect per type, so the type
 * itself is that effect's id: the same on every load, and what this app gives
 * the one Bloom of a default chain.
 */
export const legacyInstanceId = (type: PostProcessingEffectType): string => type;

export function createBloomEffect(
  overrides: Partial<BloomSettings> & { enabled?: boolean; instanceId?: string } = {},
): BloomEffect {
  const { enabled, instanceId, ...settings } = overrides;
  return {
    type: 'bloom',
    instanceId: instanceId ?? legacyInstanceId('bloom'),
    enabled: enabled ?? false,
    settings: { ...DEFAULT_BLOOM, ...settings },
  };
}

export function createVignetteEffect(
  overrides: Partial<VignetteSettings> & { enabled?: boolean; instanceId?: string } = {},
): VignetteEffect {
  const { enabled, instanceId, ...settings } = overrides;
  return {
    type: 'vignette',
    instanceId: instanceId ?? legacyInstanceId('vignette'),
    enabled: enabled ?? false,
    settings: { ...DEFAULT_VIGNETTE, ...settings },
  };
}

export function createCustomEffect(
  overrides: Partial<CustomEffectDefinition> & {
    enabled?: boolean;
    instanceId?: string;
    values?: ShaderParams;
  } = {},
): CustomEffect {
  const { enabled, instanceId, values, ...definition } = overrides;
  const controls = definition.controls ?? [];
  return {
    type: 'custom',
    instanceId: instanceId ?? legacyInstanceId('custom'),
    enabled: enabled ?? false,
    definition: {
      apiVersion: CUSTOM_EFFECT_API_VERSION,
      name: 'Custom effect',
      source: DEFAULT_CUSTOM_EFFECT_SOURCE,
      ...definition,
      controls,
    },
    values: values ?? controlDefaults(controls),
  };
}

export const DEFAULT_RENDER: RenderSettings = {
  postProcessing: { enabled: true, effects: [createBloomEffect()] },
};

/** Whether this app can execute the effect's definition. A newer `apiVersion` is kept but skipped. */
export function isCustomEffectRunnable(effect: CustomEffect): boolean {
  return effect.definition.apiVersion === CUSTOM_EFFECT_API_VERSION;
}

/**
 * An id for a new instance of `type`, unique among `taken`. Random rather than
 * counted, so a removed effect's id — and anything keyed on it, like an
 * editor's undo history — is never handed to an unrelated new one.
 */
export function newInstanceId(
  type: PostProcessingEffectType,
  taken: readonly PostProcessingEffect[],
): string {
  const used = new Set(taken.map((effect) => effect.instanceId));
  for (;;) {
    const id = `${type}-${Math.random().toString(36).slice(2, 10)}`;
    if (!used.has(id)) return id;
  }
}

/** The first Bloom in the chain, or a disabled default if there is none. */
export function getBloomEffect(render: RenderSettings): BloomEffect {
  return (
    render.postProcessing.effects.find(
      (effect): effect is BloomEffect => effect.type === 'bloom',
    ) ?? createBloomEffect()
  );
}

export function findPostProcessingEffect(
  render: RenderSettings,
  instanceId: string,
): PostProcessingEffect | undefined {
  return render.postProcessing.effects.find((effect) => effect.instanceId === instanceId);
}

/**
 * Whether the chain would actually alter the frame right now: the master
 * switch is on and at least one effect in it is enabled. This is the one
 * point that decides "is post-processing active" — callers that only need a
 * yes/no (the Wallpaper export warning, say) should use this rather than
 * re-deriving it from `postProcessing.enabled` and each effect separately.
 */
export function hasActivePostProcessing(render: RenderSettings): boolean {
  return activePostProcessingCount(render) > 0;
}

/** How many effects actually alter the frame: none while the master switch is off. */
export function activePostProcessingCount(render: RenderSettings): number {
  const { enabled, effects } = render.postProcessing;
  return enabled ? effects.filter((effect) => effect.enabled).length : 0;
}

/** The chain's master switch only — every effect and its order are untouched. */
export function withPostProcessingEnabled(
  render: RenderSettings,
  enabled: boolean,
): RenderSettings {
  return { postProcessing: { enabled, effects: render.postProcessing.effects } };
}

function withEffects(render: RenderSettings, effects: PostProcessingEffect[]): RenderSettings {
  return { postProcessing: { enabled: render.postProcessing.enabled, effects } };
}

/** A fresh, enabled default instance of `type` with an id not used in `chain`. */
export function createPostProcessingEffect(
  type: PostProcessingEffectType,
  chain: readonly PostProcessingEffect[],
): PostProcessingEffect {
  const instanceId = newInstanceId(type, chain);
  switch (type) {
    case 'bloom':
      return createBloomEffect({ enabled: true, instanceId });
    case 'vignette':
      return createVignetteEffect({ enabled: true, instanceId });
    case 'custom':
      return createCustomEffect({ enabled: true, instanceId });
  }
}

/**
 * Whether the chain has room for one more effect. Storage keeps at most
 * `LIMITS.postProcessingEffectCount`; one past it would preview, then vanish
 * on reload.
 */
export function canAddPostProcessingEffect(render: RenderSettings): boolean {
  return render.postProcessing.effects.length < LIMITS.postProcessingEffectCount;
}

/**
 * Appends `effect`, or a fresh default instance of a type — what the rack's Add
 * menu inserts. A no-op on a full chain.
 */
export function addPostProcessingEffect(
  render: RenderSettings,
  effect: PostProcessingEffectType | PostProcessingEffect,
): RenderSettings {
  if (!canAddPostProcessingEffect(render)) return render;
  const { effects } = render.postProcessing;
  const added =
    typeof effect === 'string'
      ? createPostProcessingEffect(effect, effects)
      : { ...effect, instanceId: newInstanceId(effect.type, effects) };
  return withEffects(render, [...effects, added]);
}

/** Inserts a copy of one instance right after it, under a new id. A no-op if it is absent or the chain is full. */
export function duplicatePostProcessingEffect(
  render: RenderSettings,
  instanceId: string,
): RenderSettings {
  if (!canAddPostProcessingEffect(render)) return render;
  const { effects } = render.postProcessing;
  const index = effects.findIndex((effect) => effect.instanceId === instanceId);
  if (index < 0) return render;
  const original = effects[index]!;
  const copy: PostProcessingEffect = {
    ...(JSON.parse(JSON.stringify(original)) as PostProcessingEffect),
    instanceId: newInstanceId(original.type, effects),
  };
  return withEffects(render, [...effects.slice(0, index + 1), copy, ...effects.slice(index + 1)]);
}

/**
 * Replaces one instance with `update(effect)`, keeping its position. The
 * update cannot change its id or type. A no-op if it is absent.
 */
export function updatePostProcessingEffect<T extends PostProcessingEffect>(
  render: RenderSettings,
  instanceId: string,
  update: (effect: T) => T,
): RenderSettings {
  const { effects } = render.postProcessing;
  if (!effects.some((effect) => effect.instanceId === instanceId)) return render;
  return withEffects(
    render,
    effects.map((effect) =>
      effect.instanceId === instanceId
        ? { ...update(effect as T), instanceId, type: effect.type }
        : effect,
    ),
  );
}

/** Drops one instance entirely. Not the same as disabling it. */
export function removePostProcessingEffect(
  render: RenderSettings,
  instanceId: string,
): RenderSettings {
  return withEffects(
    render,
    render.postProcessing.effects.filter((effect) => effect.instanceId !== instanceId),
  );
}

/** Toggles one instance's own switch, leaving its settings and position untouched. */
export function setPostProcessingEffectEnabled(
  render: RenderSettings,
  instanceId: string,
  enabled: boolean,
): RenderSettings {
  return updatePostProcessingEffect(render, instanceId, (effect) => ({ ...effect, enabled }));
}

/**
 * Resets one instance's settings — or a custom effect's values — to their
 * defaults, keeping its enabled state, position and (for custom) its code.
 */
export function resetPostProcessingEffect(
  render: RenderSettings,
  instanceId: string,
): RenderSettings {
  return updatePostProcessingEffect(render, instanceId, (effect): PostProcessingEffect => {
    switch (effect.type) {
      case 'bloom':
        return { ...effect, settings: { ...DEFAULT_BLOOM } };
      case 'vignette':
        return { ...effect, settings: { ...DEFAULT_VIGNETTE } };
      case 'custom':
        return { ...effect, values: controlDefaults(effect.definition.controls) };
    }
  });
}

/** Swaps one instance with its neighbor toward `direction`. A no-op at either end, or if it is absent. */
export function movePostProcessingEffect(
  render: RenderSettings,
  instanceId: string,
  direction: 'up' | 'down',
): RenderSettings {
  const { effects } = render.postProcessing;
  const index = effects.findIndex((effect) => effect.instanceId === instanceId);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= effects.length) return render;

  const next = [...effects];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved!);
  return withEffects(render, next);
}

/** Moves one instance to sit just before `beforeId` (or last when `null`). A no-op if either is absent. */
export function reorderPostProcessingEffect(
  render: RenderSettings,
  instanceId: string,
  beforeId: string | null,
): RenderSettings {
  const { effects } = render.postProcessing;
  const moved = effects.find((effect) => effect.instanceId === instanceId);
  if (!moved || instanceId === beforeId) return render;
  const rest = effects.filter((effect) => effect !== moved);
  const at = beforeId === null ? rest.length : rest.findIndex((e) => e.instanceId === beforeId);
  if (at < 0) return render;
  return withEffects(render, [...rest.slice(0, at), moved, ...rest.slice(at)]);
}

// `defaultParams` lives with the validators; this file stays free of them.
function controlDefaults(controls: readonly ShaderControl[]): ShaderParams {
  return Object.fromEntries(controls.map((control) => [control.key, control.default]));
}
