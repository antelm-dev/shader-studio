import type * as THREE from 'three';
import type { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import type { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

import {
  MAX_WAVES,
  UNIFORM_PREFIX,
  type RenderSettings,
  type ParamValue,
  type ShaderControl,
  type ShaderParams,
  type TextureFilterMode,
  type TextureWrapMode,
} from '@shader-studio/shared/model';
import type { CompileDiagnostic } from '../core/diagnostic';
import { GlContext, type GlContextOptions, type ThreeModule } from './gl-context';
import { parseInfoLog, prefixLineCount } from './glsl-diagnostics';
import { expandMacros } from './glsl-export';

/** A channel resolved to something `THREE.TextureLoader` can actually load. */
export interface ChannelSource {
  url: string;
  wrap: TextureWrapMode;
  filter: TextureFilterMode;
  flipY: boolean;
}

const CHANNEL_COUNT = 4;
const CHANNEL_UNIFORMS = ['iChannel0', 'iChannel1', 'iChannel2', 'iChannel3'] as const;

/**
 * The WebGL side of the studio. Knows nothing about Angular, HTTP or the
 * document model — you hand it a shader and some parameter values, and it puts
 * pixels on a canvas.
 *
 * The contract that matters: **a failed compile never takes down the picture.**
 * A candidate shader is compiled against an offscreen 1×1 target first, and the
 * live material is only swapped in once the driver has accepted it. If it did
 * not, the previous shader keeps rendering and the driver's log comes back as
 * diagnostics.
 *
 * An engine belongs to exactly one `GlContext`, and every GPU resource it makes
 * — materials, textures, the probe target — is tagged with that context's id.
 * Two engines can therefore run side by side without either being able to reach
 * into the other's GPU state, and a context lost under one of them suspends
 * only that one. Nothing here is shared at module scope.
 *
 * three.js and its post-processing passes are imported dynamically: none of
 * this exists on the server, and keeping it out of the initial bundle means the
 * app shell paints before the renderer is even downloaded.
 */

export interface ShaderSpec {
  fragment: string;
  vertex: string;
  controls: readonly ShaderControl[];
  params: ShaderParams;
  render: RenderSettings;
  /** Exactly four entries: iChannel0…3. `null` means nothing is assigned. */
  channels: readonly (ChannelSource | null)[];
}

/** The live state an offline capture displaces, kept so `endOffline` can put it back. */
interface OfflineState {
  time: number;
  paused: boolean;
  autoRipples: boolean;
  /** The drawing buffer the capture owns. Every `resize` during it lands back here. */
  width: number;
  height: number;
}

/** Uniforms the engine supplies to every shader, whether it declares them or not. */
export const BUILT_IN_UNIFORMS = [
  'iTime',
  'iResolution',
  'iMouse',
  'iMouseVel',
  'u_clickData',
  'iChannel0',
  'iChannel1',
  'iChannel2',
  'iChannel3',
] as const;

const PLACEHOLDER_FRAGMENT = `precision mediump float;
void main() { gl_FragColor = vec4(0.02, 0.03, 0.05, 1.0); }`;

const PLACEHOLDER_VERTEX = `void main() { gl_Position = vec4(position, 1.0); }`;

export class ShaderEngine {
  private readonly clickData: THREE.Vector3[];
  private nextWaveIndex = 0;

  private readonly scene: THREE.Scene;
  private readonly camera: THREE.OrthographicCamera;
  private readonly mesh: THREE.Mesh;

  /** A separate one-pixel scene used to compile candidates without showing them. */
  private readonly probeScene: THREE.Scene;
  private readonly probeMesh: THREE.Mesh;
  private readonly probeTarget: THREE.WebGLRenderTarget;

  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;

  private uniforms: Record<string, THREE.IUniform> = {};
  private controls: readonly ShaderControl[] = [];
  private material: THREE.ShaderMaterial;

  /** Keyed by `url|wrap|filter|flipY`, so swapping settings on the same image gets its own entry. */
  private readonly textureCache = new Map<string, THREE.Texture>();
  private readonly placeholderTexture: THREE.Texture;

  private render: RenderSettings = {
    bloom: { enabled: false, strength: 0.3, radius: 0.5, threshold: 0.85 },
  };

  private frame = 0;
  private lastFrameTime = 0;
  private time = 0;
  private paused = false;
  private autoRipples = false;
  private nextAutoRipple = 0;
  private resolutionScale = 1;

  /** Set for as long as the clock belongs to a caller rather than to the wall. */
  private offline: OfflineState | null = null;

  private fpsAccumulator = 0;
  private fpsFrames = 0;

  private readonly pointer: THREE.Vector2;
  private readonly pointerVelocity: THREE.Vector2;
  private lastPointer: THREE.Vector2 | null = null;
  private lastPointerTime = 0;

  private disposed = false;

  /**
   * The last spec the driver accepted. Kept so a restored context can be
   * brought back to exactly what it was showing when it died — the shader is
   * the only thing a lost context cannot reconstruct on its own.
   */
  private lastSpec: ShaderSpec | null = null;

  private readonly unsubscribe: (() => void)[] = [];

  onFps: ((fps: number) => void) | null = null;

  /** Fired when this engine's context is lost or comes back. Never fired for a sibling's. */
  onContextLost: (() => void) | null = null;
  onContextRestored: (() => void) | null = null;

  private readonly three: ThreeModule;
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;

  private constructor(readonly context: GlContext) {
    const T = context.three;
    this.three = T;
    this.canvas = context.canvas;
    this.renderer = context.renderer;

    this.scene = new T.Scene();
    this.camera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.clickData = Array.from({ length: MAX_WAVES }, () => new T.Vector3(0, 0, 0));
    this.pointer = new T.Vector2(-1000, -1000);
    this.pointerVelocity = new T.Vector2();

    this.material = context.own(
      new T.ShaderMaterial({
        vertexShader: PLACEHOLDER_VERTEX,
        fragmentShader: PLACEHOLDER_FRAGMENT,
        uniforms: {},
      }),
    );

    const geometry = context.own(new T.PlaneGeometry(2, 2));
    this.mesh = new T.Mesh(geometry, this.material);
    this.scene.add(this.mesh);

    this.probeScene = new T.Scene();
    this.probeMesh = new T.Mesh(geometry, this.material);
    this.probeScene.add(this.probeMesh);
    this.probeTarget = context.own(new T.WebGLRenderTarget(1, 1));

    // A fully transparent 1×1 pixel: what an unassigned iChannel samples, so a
    // shader that declares `uniform sampler2D iChannelN` always compiles and
    // renders sensibly, with or without an image behind it.
    this.placeholderTexture = context.own(
      new T.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, T.RGBAFormat),
    );
    this.placeholderTexture.needsUpdate = true;

    this.unsubscribe.push(
      context.onLost(() => this.handleContextLost()),
      context.onRestored(() => this.handleContextRestored()),
      context.onDispose(() => this.dispose()),
    );

    this.attachPointerListeners();
    this.resize();
  }

  /**
   * Creates an engine on a context. Passing a bare canvas still works and gives
   * the engine a context of its own, which is what the single-preview case has
   * always been — it is now just the one-context case of the general one.
   */
  static async create(
    target: HTMLCanvasElement | GlContext,
    options: GlContextOptions = {},
  ): Promise<ShaderEngine> {
    const context = target instanceof GlContext ? target : await GlContext.create(target, options);

    const engine = new ShaderEngine(context);
    engine.start();
    return engine;
  }

  // -------------------------------------------------------------------------
  // Shader lifecycle
  // -------------------------------------------------------------------------

  /**
   * Compile a shader and, if the driver accepts it, make it the live one.
   *
   * Returns the diagnostics. An empty array means it compiled; a non-empty one
   * means the *previous* shader is still on screen and these are the reasons
   * why the new one is not.
   */
  setShader(spec: ShaderSpec): CompileDiagnostic[] {
    if (this.disposed) return [];

    // A lost context has no driver to compile against. Remember what was asked
    // for and apply it on restore, rather than reporting a compile failure the
    // shader is not responsible for.
    if (this.context.status() === 'lost') {
      this.lastSpec = spec;
      return [];
    }

    const T = this.three;
    const fragment = expandMacros(spec.fragment);
    const vertex = expandMacros(spec.vertex);

    const uniforms = this.buildUniforms(spec.controls, spec.params, spec.channels);
    const candidate = this.context.own(
      new T.ShaderMaterial({
        vertexShader: vertex,
        fragmentShader: fragment,
        uniforms,
      }),
    );

    const diagnostics = this.probe(candidate, fragment, vertex);
    if (diagnostics.length > 0) {
      candidate.dispose();
      return diagnostics;
    }

    const previous = this.material;
    this.material = candidate;
    this.uniforms = uniforms;
    this.controls = spec.controls;
    this.mesh.material = candidate;
    previous.dispose();

    this.lastSpec = spec;
    this.setRenderSettings(spec.render);
    this.pruneTextureCache(spec.channels);
    return [];
  }

  /** The shader currently on screen: the last one the driver accepted. */
  get activeShader(): { fragment: string; vertex: string } {
    return {
      fragment: this.material.fragmentShader,
      vertex: this.material.vertexShader,
    };
  }

  /**
   * Compile a candidate without letting it touch the screen.
   *
   * three.js compiles lazily on first draw, so the only way to know whether a
   * shader is valid is to draw with it — hence the 1×1 offscreen target. When
   * `onShaderError` is set, three hands us the driver's log instead of throwing.
   */
  private probe(
    material: THREE.ShaderMaterial,
    fragment: string,
    vertex: string,
  ): CompileDiagnostic[] {
    const diagnostics: CompileDiagnostic[] = [];
    const previousHandler = this.renderer.debug.onShaderError;
    const previousTarget = this.renderer.getRenderTarget();

    this.renderer.debug.onShaderError = (gl, program, glVertexShader, glFragmentShader) => {
      const fragmentSource = gl.getShaderSource(glFragmentShader) ?? '';
      const vertexSource = gl.getShaderSource(glVertexShader) ?? '';

      diagnostics.push(
        ...parseInfoLog(
          gl.getShaderInfoLog(glFragmentShader) ?? '',
          'fragment',
          prefixLineCount(fragmentSource, fragment),
        ),
        ...parseInfoLog(
          gl.getShaderInfoLog(glVertexShader) ?? '',
          'vertex',
          prefixLineCount(vertexSource, vertex),
        ),
      );

      // A program can link-fail with both shaders clean — mismatched varyings,
      // too many uniforms. Without this the user would see a silent failure.
      if (diagnostics.length === 0) {
        const log = (gl.getProgramInfoLog(program) ?? '').trim();
        diagnostics.push({
          severity: 'error',
          line: 0,
          message: log || 'The shader program failed to link',
          source: 'fragment',
        });
      }
    };

    this.probeMesh.material = material;
    try {
      this.renderer.setRenderTarget(this.probeTarget);
      this.renderer.render(this.probeScene, this.camera);
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        line: 0,
        message: `Renderer rejected the shader: ${String(error)}`,
        source: 'fragment',
      });
    } finally {
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.debug.onShaderError = previousHandler;
      this.probeMesh.material = this.material;
    }

    return diagnostics;
  }

  private buildUniforms(
    controls: readonly ShaderControl[],
    params: ShaderParams,
    channels: readonly (ChannelSource | null)[],
  ): Record<string, THREE.IUniform> {
    const T = this.three;

    const uniforms: Record<string, THREE.IUniform> = {
      iTime: { value: this.time },
      iResolution: { value: new T.Vector2(1, 1) },
      iMouse: { value: new T.Vector4(-1000, -1000, 0, 0) },
      iMouseVel: { value: new T.Vector2(0, 0) },
      u_clickData: { value: this.clickData },
    };

    for (let index = 0; index < CHANNEL_COUNT; index++) {
      uniforms[CHANNEL_UNIFORMS[index]] = { value: this.resolveTexture(channels[index] ?? null) };
    }

    for (const control of controls) {
      const value = params[control.key] ?? control.default;
      uniforms[UNIFORM_PREFIX + control.key] = {
        value: control.type === 'color' ? new T.Color(String(value)) : value,
      };
    }

    // Carry the live resolution across a recompile so the first frame after an
    // edit is not rendered against a 1×1 viewport.
    const existing = this.uniforms['iResolution']?.value as THREE.Vector2 | undefined;
    if (existing) (uniforms['iResolution'].value as THREE.Vector2).copy(existing);

    return uniforms;
  }

  // -------------------------------------------------------------------------
  // Texture channels (iChannel0…3)
  // -------------------------------------------------------------------------

  private static cacheKey(spec: ChannelSource): string {
    return `${spec.url}|${spec.wrap}|${spec.filter}|${spec.flipY}`;
  }

  private wrapModeFor(wrap: TextureWrapMode): THREE.Wrapping {
    const T = this.three;
    switch (wrap) {
      case 'repeat':
        return T.RepeatWrapping;
      case 'mirror':
        return T.MirroredRepeatWrapping;
      case 'clamp':
      default:
        return T.ClampToEdgeWrapping;
    }
  }

  /**
   * Gets or creates the `THREE.Texture` for a resolved channel. `load()`
   * returns synchronously — an empty texture that fills itself in once the
   * image decodes — so binding a channel never blocks a compile on the
   * network or disk, matching the contract the rest of the engine keeps.
   */
  private resolveTexture(spec: ChannelSource | null): THREE.Texture {
    if (!spec) return this.placeholderTexture;

    const key = ShaderEngine.cacheKey(spec);
    const cached = this.textureCache.get(key);
    if (cached) return cached;

    const texture = this.context.own(
      new this.three.TextureLoader().load(spec.url, undefined, undefined, (error) => {
        console.warn(`[shader-engine] failed to load texture "${spec.url}":`, error);
      }),
    );

    const wrap = this.wrapModeFor(spec.wrap);
    texture.wrapS = wrap;
    texture.wrapT = wrap;
    texture.magFilter =
      spec.filter === 'nearest' ? this.three.NearestFilter : this.three.LinearFilter;
    texture.minFilter = texture.magFilter;
    texture.generateMipmaps = false;
    texture.flipY = spec.flipY;

    this.textureCache.set(key, texture);
    return texture;
  }

  /** Disposes any cached texture no longer referenced by the current channels. */
  private pruneTextureCache(channels: readonly (ChannelSource | null)[]): void {
    const used = new Set(
      channels
        .filter((channel): channel is ChannelSource => channel !== null)
        .map(ShaderEngine.cacheKey),
    );
    for (const [key, texture] of this.textureCache) {
      if (used.has(key)) continue;
      texture.dispose();
      this.textureCache.delete(key);
    }
  }

  // -------------------------------------------------------------------------
  // Parameters
  // -------------------------------------------------------------------------

  setParams(params: ShaderParams): void {
    for (const control of this.controls) {
      const value = params[control.key];
      if (value !== undefined) this.setParam(control.key, value);
    }
  }

  setParam(key: string, value: ParamValue): void {
    const uniform = this.uniforms[UNIFORM_PREFIX + key];
    if (!uniform) return;

    const control = this.controls.find((entry) => entry.key === key);
    if (control?.type === 'color') {
      (uniform.value as THREE.Color).set(String(value));
    } else {
      uniform.value = value;
    }
  }

  /**
   * Rebinds iChannel0…3 without touching the compiled program: swapping which
   * image a channel points at (or its wrap/filter/flip) is just a new uniform
   * value, never a reason to recompile.
   */
  setChannels(channels: readonly (ChannelSource | null)[]): void {
    if (this.disposed) return;
    for (let index = 0; index < CHANNEL_COUNT; index++) {
      const uniform = this.uniforms[CHANNEL_UNIFORMS[index]];
      if (uniform) uniform.value = this.resolveTexture(channels[index] ?? null);
    }
    this.pruneTextureCache(channels);
  }

  /** The texture a channel currently samples, placeholder included. */
  channelTexture(index: number): THREE.Texture | null {
    const uniform = this.uniforms[CHANNEL_UNIFORMS[index]];
    return (uniform?.value as THREE.Texture | undefined) ?? null;
  }

  /**
   * Binds an already-created texture to a channel.
   *
   * The ownership check is the point: a `THREE.Texture` from another engine
   * looks perfectly valid here, and three would take it and quietly upload a
   * second copy into this context — two GPU allocations behind one object, and
   * whichever engine disposes first pulls the texture out from under the other.
   * Refuse it loudly instead.
   */
  setChannelTexture(index: number, texture: THREE.Texture): void {
    if (this.disposed) return;
    if (index < 0 || index >= CHANNEL_COUNT) {
      throw new RangeError(`Channel ${index} does not exist: there are ${CHANNEL_COUNT}.`);
    }
    this.context.assertOwns(texture, `texture for iChannel${index}`);

    const uniform = this.uniforms[CHANNEL_UNIFORMS[index]];
    if (uniform) uniform.value = texture;
  }

  // -------------------------------------------------------------------------
  // Render settings
  // -------------------------------------------------------------------------

  setRenderSettings(render: RenderSettings): void {
    this.render = render;

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

  /** Post-processing is only downloaded if a shader actually asks for bloom. */
  private async ensureComposer(): Promise<void> {
    if (this.composer || this.disposed) return;

    const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }] = await Promise.all([
      import('three/examples/jsm/postprocessing/EffectComposer.js'),
      import('three/examples/jsm/postprocessing/RenderPass.js'),
      import('three/examples/jsm/postprocessing/UnrealBloomPass.js'),
    ]);
    if (this.disposed || this.composer) return;

    const composer = new EffectComposer(this.renderer);
    composer.addPass(new RenderPass(this.scene, this.camera));

    const bloom = new UnrealBloomPass(
      new this.three.Vector2(1, 1),
      this.render.bloom.strength,
      this.render.bloom.radius,
      this.render.bloom.threshold,
    );
    composer.addPass(bloom);

    this.composer = composer;
    this.bloomPass = bloom;
    this.resize();
  }

  private disposeComposer(): void {
    this.composer?.dispose();
    this.composer = null;
    this.bloomPass = null;
  }

  /**
   * While a capture runs, these three are the live preview's business, not the
   * capture's — and the preview's settings keep arriving, because the panel that
   * pushes them has no idea a capture is happening. So they are recorded against
   * the state `endOffline` will restore rather than applied to a clock, a
   * randomness and a resolution the capture has taken ownership of.
   */
  setPaused(paused: boolean): void {
    if (this.offline) this.offline.paused = paused;
    else this.paused = paused;
  }

  setAutoRipples(enabled: boolean): void {
    if (this.offline) this.offline.autoRipples = enabled;
    else this.autoRipples = enabled;
  }

  setResolutionScale(scale: number): void {
    this.resolutionScale = Math.min(Math.max(scale, 0.25), 2);
    this.resize();
  }

  // -------------------------------------------------------------------------
  // Sizing
  // -------------------------------------------------------------------------

  resize(): void {
    if (this.disposed) return;

    // A capture owns the drawing buffer for its duration. The window can be
    // dragged, the panel re-laid-out, the ResizeObserver can fire as often as it
    // likes: every one of them lands back on the capture's size. Routing rather
    // than ignoring also means anything that legitimately needs a resize while a
    // capture runs — a composer built the moment bloom is switched on — is sized
    // for the frames being captured, not for the panel behind them.
    const offline = this.offline;
    if (offline) {
      this.setDrawingBufferSize(offline.width, offline.height, 1);
      return;
    }

    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;

    this.setDrawingBufferSize(width, height, this.resolutionScale);
  }

  /**
   * Sizes the renderer, the composer and the bloom together, and tells the
   * shader about it. `iResolution` is in drawing-buffer pixels — the space
   * `iMouse` and `u_clickData` are in — so it is the *scaled* size that goes in,
   * never the CSS one.
   */
  private setDrawingBufferSize(width: number, height: number, scale: number): void {
    this.renderer.setPixelRatio(scale);
    // `false`: never touch the CSS size. On screen that keeps the canvas filling
    // its panel; during a capture it is what lets a 4K buffer sit behind an
    // 800px canvas without the layout so much as flinching.
    this.renderer.setSize(width, height, false);

    this.composer?.setPixelRatio(scale);
    this.composer?.setSize(width, height);
    this.bloomPass?.setSize(width * scale, height * scale);

    const resolution = this.uniforms['iResolution']?.value as THREE.Vector2 | undefined;
    resolution?.set(width * scale, height * scale);
  }

  // -------------------------------------------------------------------------
  // Offline capture
  // -------------------------------------------------------------------------

  /**
   * The surface the frames land on. Only meaningful between `beginOffline` and
   * `endOffline`, where its backing store is the capture's size.
   */
  get surface(): HTMLCanvasElement {
    return this.canvas;
  }

  get capturing(): boolean {
    return this.offline !== null;
  }

  /**
   * Takes the clock away from the wall and hands it to the caller.
   *
   * Everything that made the live picture depend on *when* it was drawn is shut
   * off here: the animation loop (frames now come from `renderAt`, one per
   * call), the pointer (frozen off-screen, its listeners inert), the ripples the
   * pointer left behind, and the auto-ripples, which are seeded from
   * `Math.random()` and so could never be reproduced. What is left is a pure
   * function from `iTime` to pixels — which is what makes a capture repeatable.
   *
   * The drawing buffer is resized to the capture, and the CSS size is untouched,
   * so the preview keeps its place in the layout while it fills with 4K frames.
   */
  beginOffline(width: number, height: number): void {
    if (this.disposed) throw new Error('This engine has been disposed.');
    if (this.offline) throw new Error('This engine is already capturing.');
    if (this.context.status() !== 'live') {
      throw new Error('The WebGL context is not live, so there is nothing to capture.');
    }

    cancelAnimationFrame(this.frame);

    this.offline = {
      time: this.time,
      paused: this.paused,
      autoRipples: this.autoRipples,
      width,
      height,
    };

    this.autoRipples = false;
    this.paused = true;

    this.pointer.set(-1000, -1000);
    this.pointerVelocity.set(0, 0);
    this.lastPointer = null;
    this.mouseUniform?.set(-1000, -1000, 0, 0);
    const velocity = this.uniforms['iMouseVel']?.value as THREE.Vector2 | undefined;
    velocity?.set(0, 0);
    // Ripples carry the timestamp of the click that made them. Left in, they
    // would fire — or worse, half-fire — somewhere in the middle of the capture.
    for (const wave of this.clickData) wave.set(0, 0, 0);
    this.nextWaveIndex = 0;

    // Pixel ratio 1: the capture's size *is* the buffer's size, and the caller
    // has already folded any supersampling into it.
    this.resize();
  }

  /**
   * Draws one frame at exactly `time`, synchronously.
   *
   * The frame is on the canvas when this returns — `preserveDrawingBuffer` is on
   * (see `GlContext`), so it stays there to be read back rather than being
   * discarded at the end of the tick.
   */
  renderAt(time: number): void {
    if (!this.offline)
      throw new Error('renderAt is only valid between beginOffline and endOffline.');
    if (this.disposed) return;

    this.time = time;
    const iTime = this.uniforms['iTime'];
    if (iTime) iTime.value = time;

    this.draw();
  }

  /** Gives the clock back to the wall, and the canvas back to its panel. */
  endOffline(): void {
    const offline = this.offline;
    if (!offline) return;

    this.offline = null;

    // The preview resumes where it was, not where the capture left off: filming
    // the shader is not the same as scrubbing it.
    this.time = offline.time;
    this.paused = offline.paused;
    this.autoRipples = offline.autoRipples;

    const iTime = this.uniforms['iTime'];
    if (iTime) iTime.value = this.time;

    if (this.disposed) return;

    this.resize();
    this.lastFrameTime = performance.now();
    this.start();
  }

  // -------------------------------------------------------------------------
  // Pointer
  // -------------------------------------------------------------------------

  private attachPointerListeners(): void {
    const canvas = this.canvas;
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('contextmenu', this.onContextMenu);
  }

  private toBufferSpace(event: PointerEvent): THREE.Vector2 {
    const rect = this.canvas.getBoundingClientRect();
    const scale = this.resolutionScale;
    return new this.three.Vector2(
      (event.clientX - rect.left) * scale,
      // GL's origin is bottom-left; the DOM's is top-left.
      (rect.height - (event.clientY - rect.top)) * scale,
    );
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    // A capture is a function of `iTime` alone. A mouse crossing the canvas
    // while it runs would write itself into the frames.
    if (this.offline) return;

    const position = this.toBufferSpace(event);
    const now = performance.now();

    if (this.lastPointer) {
      const dt = Math.max((now - this.lastPointerTime) / 1000, 1 / 240);
      // Exponential smoothing: raw per-event deltas are far too jittery to
      // drive a smear, and they spike whenever a frame is dropped.
      this.pointerVelocity.lerp(
        new this.three.Vector2().subVectors(position, this.lastPointer).divideScalar(dt),
        0.25,
      );
    }

    this.lastPointer = position.clone();
    this.lastPointerTime = now;
    this.pointer.copy(position);
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.offline) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const position = this.toBufferSpace(event);
    this.pointer.copy(position);
    this.mouseUniform?.set(position.x, position.y, 1, 0);
    this.spawnRipple(position.x, position.y);
  };

  private readonly onPointerUp = (): void => {
    if (this.offline) return;
    const mouse = this.mouseUniform;
    if (mouse) mouse.z = 0;
  };

  private readonly onPointerLeave = (): void => {
    if (this.offline) return;
    this.pointer.set(-1000, -1000);
    this.pointerVelocity.set(0, 0);
    this.lastPointer = null;
    const mouse = this.mouseUniform;
    if (mouse) mouse.z = 0;
  };

  private readonly onContextMenu = (event: Event): void => event.preventDefault();

  private get mouseUniform(): THREE.Vector4 | undefined {
    return this.uniforms['iMouse']?.value as THREE.Vector4 | undefined;
  }

  /** Ripples live in a fixed ring of slots, oldest overwritten first. */
  private spawnRipple(x: number, y: number): void {
    this.clickData[this.nextWaveIndex].set(x, y, this.time);
    this.nextWaveIndex = (this.nextWaveIndex + 1) % MAX_WAVES;
  }

  // -------------------------------------------------------------------------
  // Loop
  // -------------------------------------------------------------------------

  private start(): void {
    // During a capture the frames come from `renderAt`, one per call. A context
    // restored mid-capture must not quietly hand the clock back to the wall —
    // `endOffline` is the only thing that starts the loop again.
    if (this.offline) return;

    this.lastFrameTime = performance.now();
    const loop = (): void => {
      if (this.disposed) return;
      this.frame = requestAnimationFrame(loop);
      this.tick();
    };
    this.frame = requestAnimationFrame(loop);
  }

  // -------------------------------------------------------------------------
  // Context loss
  // -------------------------------------------------------------------------

  /**
   * The GPU state is gone; the CPU state is not. Stop the loop — drawing into a
   * dead context is a stream of console errors and nothing on screen — and drop
   * the composer, whose render targets died with the context. The shader spec,
   * the parameters, the clock and the texture *descriptors* all survive in
   * memory, which is what makes the restore a replay rather than a reload.
   */
  private handleContextLost(): void {
    if (this.disposed) return;

    cancelAnimationFrame(this.frame);
    this.disposeComposer();
    this.onContextLost?.();
  }

  private handleContextRestored(): void {
    if (this.disposed) return;

    // three re-uploads a texture on the next draw, but only if it is told the
    // pixels it holds are new. Nothing survived on the GPU, so they all are.
    for (const texture of this.textureCache.values()) texture.needsUpdate = true;
    this.placeholderTexture.needsUpdate = true;

    // Every program the driver held is gone with the context. Recompiling the
    // last accepted spec puts the material — and the composer behind it — back.
    const spec = this.lastSpec;
    if (spec) this.setShader(spec);
    else this.setRenderSettings(this.render);

    this.resize();
    this.start();
    this.onContextRestored?.();
  }

  private tick(): void {
    const now = performance.now();
    // Clamp: a backgrounded tab hands back a multi-second delta, which would
    // jump every in-flight ripple forward on return.
    const delta = Math.min((now - this.lastFrameTime) / 1000, 1 / 20);
    this.lastFrameTime = now;

    this.fpsAccumulator += delta;
    this.fpsFrames++;
    if (this.fpsAccumulator >= 0.5) {
      this.onFps?.(Math.round(this.fpsFrames / this.fpsAccumulator));
      this.fpsAccumulator = 0;
      this.fpsFrames = 0;
    }

    if (!this.paused) {
      // Time advances by delta rather than tracking the wall clock, so pausing
      // does not fast-forward the simulation on resume.
      this.time += delta;

      const iTime = this.uniforms['iTime'];
      if (iTime) iTime.value = this.time;

      const mouse = this.mouseUniform;
      if (mouse) {
        mouse.x = this.pointer.x;
        mouse.y = this.pointer.y;
      }
      const velocity = this.uniforms['iMouseVel']?.value as THREE.Vector2 | undefined;
      velocity?.copy(this.pointerVelocity);
      // Shaders can opt into a tunable amount of pointer inertia. Treat the
      // value as retention per 60 Hz frame so the feel stays stable at other
      // refresh rates; shaders without the control retain the original decay.
      const momentum = this.uniforms['u_smearMomentum']?.value;
      const velocityRetention =
        typeof momentum === 'number' ? Math.min(Math.max(momentum, 0), 0.99) : 0.9;
      this.pointerVelocity.multiplyScalar(Math.pow(velocityRetention, delta * 60));

      if (this.autoRipples && this.time >= this.nextAutoRipple) {
        const resolution = this.uniforms['iResolution']?.value as THREE.Vector2 | undefined;
        this.spawnRipple(
          Math.random() * (resolution?.x ?? 1),
          Math.random() * (resolution?.y ?? 1),
        );
        this.nextAutoRipple = this.time + 1.5 + Math.random() * 2.5;
      }
    }

    // Draw even while paused, so parameter edits stay visible with time frozen.
    this.draw();
  }

  private draw(): void {
    if (this.disposed || this.context.status() !== 'live') return;

    if (this.render.bloom.enabled && this.composer) {
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  /** Force a frame and hand back a PNG of exactly what is on screen. */
  async screenshot(): Promise<Blob | null> {
    this.draw();
    return new Promise((resolve) => this.canvas.toBlob(resolve, 'image/png'));
  }

  /**
   * Frees everything this engine put on the GPU, then tears down its context.
   * Only this context: a sibling engine keeps its renderer, its resources and
   * its loop, because it never shared any of them.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    cancelAnimationFrame(this.frame);

    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;

    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);

    this.disposeComposer();
    this.probeTarget.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
    for (const texture of this.textureCache.values()) texture.dispose();
    this.textureCache.clear();
    this.placeholderTexture.dispose();

    // Disposes the renderer. Re-entrant: this is also what runs when the
    // context is destroyed from the registry rather than from here.
    this.context.dispose();
  }
}
