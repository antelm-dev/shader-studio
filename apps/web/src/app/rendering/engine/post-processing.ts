import type * as THREE from 'three';
import type { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import type { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import type { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import type { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

import {
  DEFAULT_RENDER,
  type PostProcessingEffect,
  type PostProcessingEffectType,
  type RenderSettings,
} from '@shader-studio/shared';
import type { GlContext } from '../gl-context';
import { VIGNETTE_SHADER, setVignetteUniforms } from './vignette-pass';

/** One built pass, whichever effect type it belongs to. */
type EffectPass = UnrealBloomPass | ShaderPass;

/**
 * What happens to a frame between the shader and the canvas: the ordered
 * `postProcessing` chain from `RenderSettings`, applied after the final Image
 * pass.
 *
 * The chain has two possible members today — Bloom and Vignette — and
 * "nothing active" is the case that matters: a shader with no active effect
 * must reach the screen through `renderer.render` exactly as it always did,
 * with no composer allocated, no extra render targets, and — this is the part
 * worth protecting — no post-processing code downloaded at all.
 * `EffectComposer` and its passes are imported dynamically, inside a method,
 * so they stay out of the initial bundle and are never evaluated on the
 * server, where there is no WebGL for them to touch.
 *
 * The composer is therefore built lazily, the first time the chain asks for an
 * active effect, and torn down the moment nothing in it is still active — the
 * master switch off, or every effect disabled, are the same case. It also dies
 * with the context: its render targets are GPU objects, so a lost context
 * leaves a husk that has to be dropped and rebuilt rather than resized.
 *
 * A settings update that leaves the active chain's *types, in order*
 * unchanged is a uniform push into the passes already built (a slider drag);
 * one that changes that shape — an effect toggled, added, removed or
 * reordered — is structural: the composer is torn down and rebuilt for the
 * chain now in force. That distinction is what `activeEffects` exists to
 * make, and it is the whole reason `setSettings` never rebuilds on every
 * call. (ponytail: a structural change while a composer is already live drops
 * one frame back to direct rendering while the rebuild completes, rather than
 * patching passes in place — fine for an occasional rack edit, not for a
 * per-frame hot path.)
 *
 * `render()` is the whole point of the type: callers hand over a scene and a
 * camera and never learn which of the two paths drew them.
 */

/**
 * The three.js post-processing surface, as the dynamic import hands it over.
 * Named as an interface so a test can stand in for it, exactly as `GlBackend`
 * stands in for three itself — there is no WebGL in jsdom for a real
 * `EffectComposer` to allocate its render targets against.
 */
export interface PostProcessingModules {
  EffectComposer: typeof EffectComposer;
  RenderPass: typeof RenderPass;
  UnrealBloomPass: typeof UnrealBloomPass;
  ShaderPass: typeof ShaderPass;
}

export type PostProcessingLoader = () => Promise<PostProcessingModules>;

/**
 * The one place post-processing is pulled in. `import()` inside a function is
 * what keeps it out of the initial bundle and off the server: nothing here is
 * evaluated until something actually asks for an effect, which on the server
 * is never, because there is no renderer to ask.
 */
const loadPostProcessing: PostProcessingLoader = async () => {
  const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { ShaderPass }] =
    await Promise.all([
      import('three/examples/jsm/postprocessing/EffectComposer.js'),
      import('three/examples/jsm/postprocessing/RenderPass.js'),
      import('three/examples/jsm/postprocessing/UnrealBloomPass.js'),
      import('three/examples/jsm/postprocessing/ShaderPass.js'),
    ]);
  return { EffectComposer, RenderPass, UnrealBloomPass, ShaderPass };
};

/** Whether `a` and `b` name the same effect types in the same order. */
function sameOrder(
  a: readonly PostProcessingEffectType[],
  b: readonly PostProcessingEffectType[],
): boolean {
  return a.length === b.length && a.every((type, index) => type === b[index]);
}

export class PostProcessing {
  private composer: EffectComposer | null = null;
  /** One built pass per active effect type, keyed by `type`. */
  private readonly passes = new Map<PostProcessingEffectType, EffectPass>();
  /** The active-effect order the current composer was actually built for; `null` while there is none. */
  private builtOrder: PostProcessingEffectType[] | null = null;

  private current: RenderSettings = DEFAULT_RENDER;

  private disposed = false;
  /**
   * Incremented whenever a pending composer creation is invalidated — either
   * because the active chain changed shape or the context was lost.
   * `ensureComposer` records the generation it started with and discards its
   * result if the value has changed by the time the dynamic import resolves.
   */
  private generation = 0;

  /**
   * Fired once a composer has actually been created. A composer arrives
   * asynchronously, long after the resize that would have sized it, so whoever
   * owns the drawing-buffer size is asked to state it again.
   */
  onComposerCreated: (() => void) | null = null;

  /** Fired only when rendering actually switches between direct and composer paths. */
  onRenderPathChanged: (() => void) | null = null;

  /**
   * `scene` and `camera` are the ones the composer's `RenderPass` will draw, and
   * are held only for the moment a composer is built. They are not this type's
   * state — the engine owns them — which is why `render()` is handed them again
   * rather than assuming the direct path should use these.
   */
  constructor(
    private readonly context: GlContext,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly load: PostProcessingLoader = loadPostProcessing,
  ) {}

  /** The settings in force. The engine reads these back on a context restore. */
  get settings(): RenderSettings {
    return this.current;
  }

  /**
   * The chain's effects, but only the ones that would actually run: the
   * master switch is on and the effect itself is enabled. An empty array for
   * either reason is the same "direct render" case to every caller — the one
   * point that decides it, so nothing else has to know there are two ways to
   * be off. Order matches the chain — it is what `ensureComposer` builds the
   * composer's pass order from.
   */
  private activeEffects(): PostProcessingEffect[] {
    if (!this.current.postProcessing.enabled) return [];
    return this.current.postProcessing.effects.filter((effect) => effect.enabled);
  }

  /**
   * Adopt new render settings. Losing every active effect frees the composer
   * rather than leaving it allocated and bypassed. A settings update whose
   * active types and order match what is already built is a uniform push
   * (a slider drag); anything else — the first active effect, one toggled,
   * added, removed or reordered — is structural, so any stale composer is
   * freed and a fresh one is (re)built for the chain now in force.
   */
  setSettings(render: RenderSettings): void {
    this.current = render;

    const active = this.activeEffects();
    if (active.length === 0) {
      const wasUsingComposer = this.composer !== null;
      this.disposeComposer();
      if (wasUsingComposer) this.onRenderPathChanged?.();
      return;
    }

    if (
      this.composer &&
      this.builtOrder &&
      sameOrder(
        this.builtOrder,
        active.map((effect) => effect.type),
      )
    ) {
      for (const effect of active) this.applyUniforms(effect);
      return;
    }

    this.disposeComposer();
    void this.ensureComposer();
  }

  /**
   * Draw, without telling the caller how. When at least one effect is active
   * and its composer is ready the frame goes through the chain; otherwise it
   * goes straight at the canvas. The gap between "asked for it" and "composer
   * exists" is a real state — the import is in flight — and it renders
   * directly, which is what keeps a frame appearing during it.
   */
  render(scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.activeEffects().length > 0 && this.composer) this.composer.render();
    else this.context.renderer.render(scene, camera);
  }

  /**
   * Size the chain with the drawing buffer. `scale` is the pixel ratio: the
   * composer takes CSS-ish size plus ratio. Only Bloom's kernel needs the
   * resolution in real pixels — Vignette is pure UV math and needs no resize
   * hook at all.
   */
  setSize(width: number, height: number, scale: number): void {
    this.composer?.setPixelRatio(scale);
    this.composer?.setSize(width, height);
    const bloom = this.passes.get('bloom') as UnrealBloomPass | undefined;
    bloom?.setSize(width * scale, height * scale);
  }

  /**
   * The context is gone and so are the composer's render targets. Drop it; a
   * later `restore()` or `setSettings()` builds a fresh one if an effect is
   * still active.
   */
  invalidate(): void {
    this.disposeComposer();
  }

  /** Re-apply the settings in force, rebuilding the chain a lost context took. */
  restore(): void {
    this.setSettings(this.current);
  }

  /** Frees the chain. Safe to call repeatedly, and blocks an import still in flight. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.disposeComposer();
    this.onComposerCreated = null;
  }

  /** Post-processing is only downloaded if the chain actually has an active effect. */
  usesComposer(): boolean {
    return this.activeEffects().length > 0 && this.composer !== null;
  }

  /** Builds one pass for `effect`, with its live settings already applied. */
  private createPass(
    effect: PostProcessingEffect,
    modules: Pick<PostProcessingModules, 'UnrealBloomPass' | 'ShaderPass'>,
  ): EffectPass {
    if (effect.type === 'bloom') {
      return new modules.UnrealBloomPass(
        new this.context.three.Vector2(1, 1),
        effect.settings.strength,
        effect.settings.radius,
        effect.settings.threshold,
      );
    }
    const pass = new modules.ShaderPass(VIGNETTE_SHADER);
    setVignetteUniforms(pass, effect.settings);
    return pass;
  }

  /** Pushes `effect`'s live settings into its already-built pass. */
  private applyUniforms(effect: PostProcessingEffect): void {
    const pass = this.passes.get(effect.type);
    if (!pass) return;
    if (effect.type === 'bloom') {
      const bloom = pass as UnrealBloomPass;
      bloom.strength = effect.settings.strength;
      bloom.radius = effect.settings.radius;
      bloom.threshold = effect.settings.threshold;
    } else {
      setVignetteUniforms(pass as ShaderPass, effect.settings);
    }
  }

  private async ensureComposer(): Promise<void> {
    if (this.composer || this.disposed) return;

    const startGeneration = this.generation;
    const { EffectComposer, RenderPass, UnrealBloomPass, ShaderPass } = await this.load();

    // The await is long enough for the engine to have been disposed, the
    // active chain to have changed shape again, or the context to have been
    // invalidated — any of which bumps the generation token.
    if (this.disposed || this.composer || this.generation !== startGeneration) return;

    // Re-derive from this.current rather than a captured list: a newer
    // setSettings call may have resolved first and already written its
    // values. Using a captured list would let an older continuation install
    // a stale chain shape.
    const active = this.activeEffects();

    const composer = new EffectComposer(this.context.renderer);
    composer.addPass(new RenderPass(this.scene, this.camera));

    for (const effect of active) {
      const pass = this.createPass(effect, { UnrealBloomPass, ShaderPass });
      this.passes.set(effect.type, pass);
      composer.addPass(pass);
    }

    this.composer = composer;
    this.builtOrder = active.map((effect) => effect.type);
    this.onComposerCreated?.();
    this.onRenderPathChanged?.();
  }

  private disposeComposer(): void {
    this.generation++;
    for (const pass of this.passes.values()) pass.dispose();
    this.passes.clear();
    this.composer?.dispose();
    this.composer = null;
    this.builtOrder = null;
  }
}
