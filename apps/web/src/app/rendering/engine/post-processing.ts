import type * as THREE from 'three';
import type { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import type { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import type { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

import {
  DEFAULT_RENDER,
  getBloomEffect,
  type BloomEffect,
  type RenderSettings,
} from '@shader-studio/shared';
import type { GlContext } from '../gl-context';

/**
 * What happens to a frame between the shader and the canvas: the ordered
 * `postProcessing` chain from `RenderSettings`, applied after the final Image
 * pass.
 *
 * Today the chain has one possible member — Bloom — and "nothing active" is
 * the case that matters: a shader with no active effect must reach the screen
 * through `renderer.render` exactly as it always did, with no composer
 * allocated, no extra render targets, and — this is the part worth protecting
 * — no post-processing code downloaded at all. `EffectComposer` and
 * `UnrealBloomPass` are imported dynamically, inside a method, so they stay out
 * of the initial bundle and are never evaluated on the server, where there is
 * no WebGL for them to touch.
 *
 * The composer is therefore built lazily, the first time the chain asks for an
 * active effect, and torn down the moment nothing in it is still active — the
 * master switch off, or every effect disabled, are the same case. It also dies
 * with the context: its render targets are GPU objects, so a lost context
 * leaves a husk that has to be dropped and rebuilt rather than resized.
 *
 * A settings update that leaves the *set* of active effects unchanged is a
 * uniform push into the passes already built (a slider drag); one that changes
 * it is structural — the composer is built or freed. That distinction is what
 * `activeBloom` exists to make, and it is the whole reason `setSettings` never
 * rebuilds on every call.
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
}

export type PostProcessingLoader = () => Promise<PostProcessingModules>;

/**
 * The one place post-processing is pulled in. `import()` inside a function is
 * what keeps it out of the initial bundle and off the server: nothing here is
 * evaluated until something actually asks for bloom, which on the server is
 * never, because there is no renderer to ask.
 */
const loadPostProcessing: PostProcessingLoader = async () => {
  const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }] = await Promise.all([
    import('three/examples/jsm/postprocessing/EffectComposer.js'),
    import('three/examples/jsm/postprocessing/RenderPass.js'),
    import('three/examples/jsm/postprocessing/UnrealBloomPass.js'),
  ]);
  return { EffectComposer, RenderPass, UnrealBloomPass };
};

export class PostProcessing {
  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;

  private current: RenderSettings = DEFAULT_RENDER;

  private disposed = false;
  /**
   * Incremented whenever a pending composer creation is invalidated — either
   * because bloom was disabled or the context was lost. `ensureComposer` records
   * the generation it started with and discards its result if the value has
   * changed by the time the dynamic import resolves.
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
   * The chain's Bloom effect, but only if it would actually run: the master
   * switch is on and the effect itself is enabled. `null` for either reason is
   * the same "direct render" case to every caller — the one point that decides
   * it, so nothing else has to know there are two ways to be off.
   */
  private activeBloom(): BloomEffect | null {
    if (!this.current.postProcessing.enabled) return null;
    const bloom = getBloomEffect(this.current);
    return bloom.enabled ? bloom : null;
  }

  /**
   * Adopt new render settings. Losing the active Bloom effect frees the
   * composer rather than leaving it allocated and bypassed; gaining one
   * downloads the passes if this is the first time anything has asked for
   * them, and pushes the live values through either way — a slider drag is a
   * uniform change, never a rebuild.
   */
  setSettings(render: RenderSettings): void {
    this.current = render;

    const bloom = this.activeBloom();
    if (!bloom) {
      const wasUsingComposer = this.composer !== null;
      this.disposeComposer();
      if (wasUsingComposer) this.onRenderPathChanged?.();
      return;
    }

    void this.ensureComposer().then(() => {
      // Re-derive from this.current rather than the captured `bloom`: a newer
      // setSettings call may have resolved first and already written its
      // values. Using the captured argument would let an older continuation
      // overwrite a newer composer's settings.
      const latest = this.activeBloom();
      if (!this.bloomPass || !latest) return;
      this.bloomPass.strength = latest.settings.strength;
      this.bloomPass.radius = latest.settings.radius;
      this.bloomPass.threshold = latest.settings.threshold;
    });
  }

  /**
   * Draw, without telling the caller how. When Bloom is active and its
   * composer is ready the frame goes through the chain; otherwise it goes
   * straight at the canvas. The gap between "asked for it" and "composer
   * exists" is a real state — the import is in flight — and it renders
   * directly, which is what keeps a frame appearing during it.
   */
  render(scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.activeBloom() && this.composer) this.composer.render();
    else this.context.renderer.render(scene, camera);
  }

  /**
   * Size the chain with the drawing buffer. `scale` is the pixel ratio: the
   * composer takes CSS-ish size plus ratio, while bloom wants the resolution in
   * real pixels, which is the two of them multiplied.
   */
  setSize(width: number, height: number, scale: number): void {
    this.composer?.setPixelRatio(scale);
    this.composer?.setSize(width, height);
    this.bloomPass?.setSize(width * scale, height * scale);
  }

  /**
   * The context is gone and so are the composer's render targets. Drop it; a
   * later `restore()` or `setSettings()` builds a fresh one if bloom is still
   * wanted.
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
    return this.activeBloom() !== null && this.composer !== null;
  }

  private async ensureComposer(): Promise<void> {
    if (this.composer || this.disposed) return;

    const startGeneration = this.generation;
    const { EffectComposer, RenderPass, UnrealBloomPass } = await this.load();

    // The await is long enough for the engine to have been disposed, the
    // active effect to have dropped out, or the context to have been
    // invalidated — any of which bumps the generation token.
    if (this.disposed || this.composer || this.generation !== startGeneration) return;

    const composer = new EffectComposer(this.context.renderer);
    composer.addPass(new RenderPass(this.scene, this.camera));

    const settings = getBloomEffect(this.current).settings;
    const bloom = new UnrealBloomPass(
      new this.context.three.Vector2(1, 1),
      settings.strength,
      settings.radius,
      settings.threshold,
    );
    composer.addPass(bloom);

    this.composer = composer;
    this.bloomPass = bloom;
    this.onComposerCreated?.();
    this.onRenderPathChanged?.();
  }

  private disposeComposer(): void {
    this.generation++;
    this.composer?.dispose();
    this.composer = null;
    this.bloomPass = null;
  }
}
