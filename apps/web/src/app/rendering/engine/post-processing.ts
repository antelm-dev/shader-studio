import type * as THREE from 'three';
import type { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import type { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import type { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

import type { RenderSettings } from '@shader-studio/shared';
import type { GlContext } from '../gl-context';

/**
 * What happens to a frame between the shader and the canvas.
 *
 * Today that is bloom or nothing, and "nothing" is the case that matters: a
 * shader without bloom must reach the screen through `renderer.render` exactly
 * as it always did, with no composer allocated, no extra render targets, and —
 * this is the part worth protecting — no post-processing code downloaded at all.
 * `EffectComposer` and `UnrealBloomPass` are imported dynamically, inside a
 * method, so they stay out of the initial bundle and are never evaluated on the
 * server, where there is no WebGL for them to touch.
 *
 * The composer is therefore built lazily, on the first settings that ask for
 * bloom, and torn down the moment they stop asking. It also dies with the
 * context: its render targets are GPU objects, so a lost context leaves a husk
 * that has to be dropped and rebuilt rather than resized.
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

  private current: RenderSettings = {
    bloom: { enabled: false, strength: 0.3, radius: 0.5, threshold: 0.85 },
  };

  private disposed = false;

  /**
   * Fired once a composer has actually been created. A composer arrives
   * asynchronously, long after the resize that would have sized it, so whoever
   * owns the drawing-buffer size is asked to state it again.
   */
  onComposerCreated: (() => void) | null = null;

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
   * Adopt new render settings. Turning bloom off frees the composer rather than
   * leaving it allocated and bypassed; turning it on downloads the passes if
   * this is the first time anything has asked for them, and pushes the live
   * values through either way — a slider drag is a uniform change, never a
   * rebuild.
   */
  setSettings(render: RenderSettings): void {
    this.current = render;

    if (!render.bloom.enabled) {
      this.disposeComposer();
      return;
    }

    void this.ensureComposer().then(() => {
      if (!this.bloomPass) return;
      this.bloomPass.strength = render.bloom.strength;
      this.bloomPass.radius = render.bloom.radius;
      this.bloomPass.threshold = render.bloom.threshold;
    });
  }

  /**
   * Draw, without telling the caller how. When bloom is on and its composer is
   * ready the frame goes through the chain; otherwise it goes straight at the
   * canvas. The gap between "asked for bloom" and "composer exists" is a real
   * state — the import is in flight — and it renders directly, which is what
   * keeps a frame appearing during it.
   */
  render(scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.current.bloom.enabled && this.composer) this.composer.render();
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

  /** Post-processing is only downloaded if a shader actually asks for bloom. */
  private async ensureComposer(): Promise<void> {
    if (this.composer || this.disposed) return;

    const { EffectComposer, RenderPass, UnrealBloomPass } = await this.load();
    // The await is long enough for the engine to have been disposed, or for a
    // second call to have won the race.
    if (this.disposed || this.composer) return;

    const composer = new EffectComposer(this.context.renderer);
    composer.addPass(new RenderPass(this.scene, this.camera));

    const bloom = new UnrealBloomPass(
      new this.context.three.Vector2(1, 1),
      this.current.bloom.strength,
      this.current.bloom.radius,
      this.current.bloom.threshold,
    );
    composer.addPass(bloom);

    this.composer = composer;
    this.bloomPass = bloom;
    this.onComposerCreated?.();
  }

  private disposeComposer(): void {
    this.composer?.dispose();
    this.composer = null;
    this.bloomPass = null;
  }
}
