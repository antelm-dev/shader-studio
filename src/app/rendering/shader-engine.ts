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
} from '../../shared/model';
import type { CompileDiagnostic } from '../core/diagnostic';
import { parseInfoLog, prefixLineCount } from './glsl-diagnostics';

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
}

/** Uniforms the engine supplies to every shader, whether it declares them or not. */
export const BUILT_IN_UNIFORMS = [
  'iTime',
  'iResolution',
  'iMouse',
  'iMouseVel',
  'u_clickData',
] as const;

const PLACEHOLDER_FRAGMENT = `precision mediump float;
void main() { gl_FragColor = vec4(0.02, 0.03, 0.05, 1.0); }`;

const PLACEHOLDER_VERTEX = `void main() { gl_Position = vec4(position, 1.0); }`;

type ThreeModule = typeof import('three');

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

  private fpsAccumulator = 0;
  private fpsFrames = 0;

  private readonly pointer: THREE.Vector2;
  private readonly pointerVelocity: THREE.Vector2;
  private lastPointer: THREE.Vector2 | null = null;
  private lastPointerTime = 0;

  private disposed = false;

  onFps: ((fps: number) => void) | null = null;

  private constructor(
    private readonly three: ThreeModule,
    private readonly canvas: HTMLCanvasElement,
    private readonly renderer: THREE.WebGLRenderer,
  ) {
    const T = three;

    this.scene = new T.Scene();
    this.camera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.clickData = Array.from({ length: MAX_WAVES }, () => new T.Vector3(0, 0, 0));
    this.pointer = new T.Vector2(-1000, -1000);
    this.pointerVelocity = new T.Vector2();

    this.material = new T.ShaderMaterial({
      vertexShader: PLACEHOLDER_VERTEX,
      fragmentShader: PLACEHOLDER_FRAGMENT,
      uniforms: {},
    });

    const geometry = new T.PlaneGeometry(2, 2);
    this.mesh = new T.Mesh(geometry, this.material);
    this.scene.add(this.mesh);

    this.probeScene = new T.Scene();
    this.probeMesh = new T.Mesh(geometry, this.material);
    this.probeScene.add(this.probeMesh);
    this.probeTarget = new T.WebGLRenderTarget(1, 1);

    this.attachPointerListeners();
    this.resize();
  }

  static async create(canvas: HTMLCanvasElement): Promise<ShaderEngine> {
    const three = await import('three');

    // Shader colour uniforms are authored as display-space sRGB. Leave three's
    // colour management off so it does not silently convert them to linear.
    three.ColorManagement.enabled = false;

    const renderer = new three.WebGLRenderer({
      canvas,
      antialias: true,
      // Required for `screenshot()`: without it the buffer may be cleared
      // before we get a chance to read it back.
      preserveDrawingBuffer: true,
    });
    renderer.debug.checkShaderErrors = true;

    const engine = new ShaderEngine(three, canvas, renderer);
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

    const T = this.three;
    const fragment = expandMacros(spec.fragment);
    const vertex = expandMacros(spec.vertex);

    const uniforms = this.buildUniforms(spec.controls, spec.params);
    const candidate = new T.ShaderMaterial({ vertexShader: vertex, fragmentShader: fragment, uniforms });

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

    this.setRenderSettings(spec.render);
    return [];
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
  ): Record<string, THREE.IUniform> {
    const T = this.three;

    const uniforms: Record<string, THREE.IUniform> = {
      iTime: { value: this.time },
      iResolution: { value: new T.Vector2(1, 1) },
      iMouse: { value: new T.Vector4(-1000, -1000, 0, 0) },
      iMouseVel: { value: new T.Vector2(0, 0) },
      u_clickData: { value: this.clickData },
    };

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

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  setAutoRipples(enabled: boolean): void {
    this.autoRipples = enabled;
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

    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    const scale = this.resolutionScale;

    this.renderer.setPixelRatio(scale);
    this.renderer.setSize(width, height, false);

    this.composer?.setPixelRatio(scale);
    this.composer?.setSize(width, height);
    this.bloomPass?.setSize(width * scale, height * scale);

    // Drawing-buffer pixels: the space iMouse and u_clickData live in.
    const resolution = this.uniforms['iResolution']?.value as THREE.Vector2 | undefined;
    resolution?.set(width * scale, height * scale);
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
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const position = this.toBufferSpace(event);
    this.pointer.copy(position);
    this.mouseUniform?.set(position.x, position.y, 1, 0);
    this.spawnRipple(position.x, position.y);
  };

  private readonly onPointerUp = (): void => {
    const mouse = this.mouseUniform;
    if (mouse) mouse.z = 0;
  };

  private readonly onPointerLeave = (): void => {
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
    this.lastFrameTime = performance.now();
    const loop = (): void => {
      if (this.disposed) return;
      this.frame = requestAnimationFrame(loop);
      this.tick();
    };
    this.frame = requestAnimationFrame(loop);
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    cancelAnimationFrame(this.frame);

    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);

    this.disposeComposer();
    this.probeTarget.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
    this.renderer.dispose();
  }
}

/** Substitutions the engine makes in every shader before compiling it. */
function expandMacros(source: string): string {
  return source.replaceAll('__MAX_WAVES__', String(MAX_WAVES));
}
