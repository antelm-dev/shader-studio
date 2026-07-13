import type * as THREE from 'three';
import type { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import type { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

import {
  MAX_WAVES,
  UNIFORM_PREFIX,
  legacyTextureBindings,
  locate,
  type ChannelBindings,
  type PassResolution,
  type RenderSettings,
  type ParamValue,
  type ShaderControl,
  type ShaderParams,
  type SourceSpan,
  type TextureFilterMode,
  type TextureWrapMode,
} from '@shader-studio/shared';
import { VERTEX_DOC, type CompileDiagnostic } from '@shader-studio/shared/diagnostic';
import { GlContext, type GlContextOptions, type ThreeModule } from './gl-context';
import { parseInfoLog, prefixLineCount } from '@shader-studio/shared/glsl-diagnostics';
import { expandMacros } from '@shader-studio/shared/glsl-export';
import { BufferTargets, type TargetSpec } from './pass-targets';

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

/**
 * One pass, as the engine wants it: the source already composed (Common and any
 * `#include`s folded in), with the map back to the files it came from so a
 * driver error can be blamed on the right one.
 *
 * The channel bindings arrive *unresolved* — as the document model wrote them —
 * because resolving them is the engine's job and it has to be redone every frame
 * anyway: a binding to a buffer names a texture that ping-pongs, so there is no
 * stable object a caller could have handed us.
 */
export interface EnginePass {
  id: string;
  kind: 'image' | 'buffer';
  /** Composed fragment source. Compared against the last one to skip a recompile. */
  fragment: string;
  spans: readonly SourceSpan[];
  channels: ChannelBindings;
  resolution: PassResolution;
  filter: TextureFilterMode;
  wrap: TextureWrapMode;
}

/**
 * A whole project, ready to render. `passes` is already in dependency order —
 * the buffers that have to go first, then the Image pass last. The engine does
 * not build the graph; it executes the order the graph produced.
 */
export interface MultiPassSpec {
  vertex: string;
  controls: readonly ShaderControl[];
  params: ShaderParams;
  render: RenderSettings;
  /** Buffers in render order, Image last. */
  passes: readonly EnginePass[];
  /** The shader's four image slots, which a `texture` binding points into. */
  textures: readonly (ChannelSource | null)[];
}

/** A pass the driver has accepted, and everything needed to draw and rebind it. */
interface CompiledPass {
  id: string;
  kind: 'image' | 'buffer';
  material: THREE.ShaderMaterial;
  uniforms: Record<string, THREE.IUniform>;
  channels: ChannelBindings;
  /** What it was compiled from — an identical source next time is not recompiled. */
  fragment: string;
  vertex: string;
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

/**
 * Blame a pass's compile errors on the file they actually came from.
 *
 * The driver reports a line in the source *it* was given, which is Common, plus
 * every `#include`, plus the pass — a file that exists nowhere and that the user
 * has never seen. `parseInfoLog` has already subtracted three.js's prelude; the
 * span map subtracts the rest, and what comes out is a file and a line the
 * editor can actually put a cursor on.
 *
 * A diagnostic with no line (a link failure, most often) has nothing to map, so
 * it is pinned to the pass itself — the one file that is certainly involved.
 */
function attribute(
  diagnostics: readonly CompileDiagnostic[],
  pass: EnginePass,
): CompileDiagnostic[] {
  return diagnostics.map((diagnostic) => {
    if (diagnostic.source === 'vertex') {
      return { ...diagnostic, docId: VERTEX_DOC, docName: 'Vertex' };
    }

    const at = diagnostic.line > 0 ? locate(pass.spans, diagnostic.line) : null;
    if (!at) return { ...diagnostic, docId: pass.id };

    return { ...diagnostic, line: at.line, docId: at.docId, docName: at.docName };
  });
}

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

  /**
   * The quad the buffers are drawn with. Kept apart from `scene` — which the
   * composer holds a reference to — so that swapping a material through it to
   * render four buffers cannot disturb what bloom thinks it is post-processing.
   */
  private readonly bufferScene: THREE.Scene;
  private readonly bufferMesh: THREE.Mesh;

  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;

  private uniforms: Record<string, THREE.IUniform> = {};
  private controls: readonly ShaderControl[] = [];
  private material: THREE.ShaderMaterial;

  /** The buffer passes, in the order the dependency graph said they must run. */
  private buffers: CompiledPass[] = [];
  /** The Image pass, as a compiled pass. Its material is also `this.material`. */
  private image: CompiledPass | null = null;

  private readonly targets: BufferTargets;

  /** The bindings the Image pass' channels were last set from. */
  private imageChannels: ChannelBindings = legacyTextureBindings();

  /** iChannel0…3 of the *shader record*: what a `texture` binding points into. */
  private textureSlots: readonly (ChannelSource | null)[] = [null, null, null, null];

  /** What the buffers need from `BufferTargets`, kept so a resize can re-sync. */
  private targetSpecs: TargetSpec[] = [];

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
  private lastSpec: MultiPassSpec | null = null;

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

    this.bufferScene = new T.Scene();
    this.bufferMesh = new T.Mesh(geometry, this.material);
    this.bufferScene.add(this.bufferMesh);

    this.targets = new BufferTargets(context);

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
   * Compile a single-pass shader. The original entry point, and now the
   * one-pass case of the general one: a lone Image pass sampling the four
   * texture slots, which is exactly what every shader was before buffers.
   */
  setShader(spec: ShaderSpec): CompileDiagnostic[] {
    return this.setPasses({
      vertex: spec.vertex,
      controls: spec.controls,
      params: spec.params,
      render: spec.render,
      textures: spec.channels,
      passes: [
        {
          id: 'image',
          kind: 'image',
          fragment: spec.fragment,
          spans: [],
          channels: legacyTextureBindings(),
          resolution: { mode: 'viewport', scale: 1, width: 1, height: 1 },
          filter: 'linear',
          wrap: 'clamp',
        },
      ],
    });
  }

  /**
   * Compile a whole project and, if the driver accepts it, make it the live one.
   *
   * The contract the single-pass engine kept is kept here per pass, and it is
   * the reason this is not simply "recompile everything and swap": a candidate
   * is probed offscreen, and a pass whose new source the driver rejects leaves
   * the *previously accepted* material in place. So a project whose Buffer B has
   * a typo in it keeps rendering — with the last Buffer B that worked — instead
   * of collapsing to black while you fix it, and the errors come back as
   * diagnostics rather than as a blank canvas.
   *
   * A pass whose composed source is byte-for-byte what it already compiled is
   * skipped entirely. That is what makes an edit to Buffer C recompile Buffer C
   * and nothing else, and an edit to Common recompile every pass that actually
   * uses it — the caller does not have to work out which passes are affected,
   * because an unaffected pass composes to the same string it did last time.
   */
  setPasses(spec: MultiPassSpec, force = false): CompileDiagnostic[] {
    if (this.disposed) return [];

    // A lost context has no driver to compile against. Remember what was asked
    // for and apply it on restore, rather than reporting a compile failure the
    // shader is not responsible for.
    if (this.context.status() === 'lost') {
      this.lastSpec = spec;
      return [];
    }

    // Before anything is compiled: `buildUniforms` resolves a `texture` binding
    // through these, and a pass built against stale slots would come out of the
    // compiler bound to the placeholder.
    this.setTextureSlots(spec.textures);

    const vertex = expandMacros(spec.vertex);
    const diagnostics: CompileDiagnostic[] = [];

    const previous = new Map(
      [...this.buffers, ...(this.image ? [this.image] : [])].map((pass) => [pass.id, pass]),
    );

    const compiled: CompiledPass[] = [];

    for (const pass of spec.passes) {
      const fragment = expandMacros(pass.fragment);
      const existing = previous.get(pass.id);

      // Same source, same vertex: the program on the GPU is already the right
      // one. Rebind its channels and its params and move on. `force` is what
      // Ctrl+Enter means — recompile even though nothing changed.
      if (!force && existing && existing.fragment === fragment && existing.vertex === vertex) {
        existing.channels = pass.channels;
        this.applyParams(existing, spec.controls, spec.params);
        compiled.push(existing);
        previous.delete(pass.id);
        continue;
      }

      const result = this.compilePass(pass, fragment, vertex, spec);

      if (result.diagnostics.length > 0) {
        diagnostics.push(...result.diagnostics);

        // Rejected. Keep whatever was on the GPU for this pass, so the picture
        // survives the failure — that is the whole contract.
        if (existing) {
          existing.channels = pass.channels;
          compiled.push(existing);
          previous.delete(pass.id);
        }
        continue;
      }

      if (existing) existing.material.dispose();
      previous.delete(pass.id);
      compiled.push(result.pass);
    }

    // Anything left in `previous` belongs to a pass that is no longer in the
    // project — a deleted or disabled buffer. Its program is now garbage.
    for (const orphan of previous.values()) orphan.material.dispose();

    this.controls = spec.controls;
    this.lastSpec = spec;

    const image = compiled.find((pass) => pass.kind === 'image') ?? null;
    this.buffers = compiled.filter((pass) => pass.kind === 'buffer');

    if (image) {
      this.image = image;
      this.material = image.material;
      this.uniforms = image.uniforms;
      this.imageChannels = image.channels;
      this.mesh.material = image.material;
    }

    this.targetSpecs = spec.passes
      .filter((pass) => pass.kind === 'buffer')
      .map((pass) => ({
        id: pass.id,
        resolution: pass.resolution,
        filter: pass.filter,
        wrap: pass.wrap,
      }));

    // Targets first, so that a binding to a brand-new buffer has something to
    // resolve to; then bind, so the channels are right the instant this returns
    // rather than only once the next frame is drawn.
    this.syncTargets();
    for (const pass of this.eachPass()) this.bindChannels(pass);

    this.setRenderSettings(spec.render);

    return diagnostics;
  }

  /**
   * Build and probe one pass. On success the material is live but not yet
   * installed — `setPasses` decides that, because it is the only thing that
   * knows whether the rest of the project compiled too.
   */
  private compilePass(
    pass: EnginePass,
    fragment: string,
    vertex: string,
    spec: MultiPassSpec,
  ): { pass: CompiledPass; diagnostics: CompileDiagnostic[] } {
    const T = this.three;

    const uniforms = this.buildUniforms(spec.controls, spec.params, pass.channels);
    const material = this.context.own(
      new T.ShaderMaterial({ vertexShader: vertex, fragmentShader: fragment, uniforms }),
    );

    const raw = this.probe(material, fragment, vertex);
    if (raw.length > 0) {
      material.dispose();
      return { pass: null as never, diagnostics: attribute(raw, pass) };
    }

    return {
      pass: {
        id: pass.id,
        kind: pass.kind,
        material,
        uniforms,
        channels: pass.channels,
        fragment,
        vertex,
      },
      diagnostics: [],
    };
  }

  /** The shader currently on screen: the last one the driver accepted. */
  get activeShader(): { fragment: string; vertex: string } {
    return {
      fragment: this.material.fragmentShader,
      vertex: this.material.vertexShader,
    };
  }

  /** The passes the driver has accepted, in render order. Image last. */
  get activePasses(): readonly { id: string; kind: 'image' | 'buffer' }[] {
    return [...this.eachPass()].map((pass) => ({ id: pass.id, kind: pass.kind }));
  }

  /**
   * The program a pass is currently running.
   *
   * Its *identity* is the observable fact worth having: an unchanged object
   * across two `setPasses` calls is the engine telling you it did not recompile
   * that pass, and a changed one that it did.
   */
  passMaterial(passId: string): THREE.ShaderMaterial | null {
    for (const pass of this.eachPass()) {
      if (pass.id === passId) return pass.material;
    }
    return null;
  }

  /** The texture one pass's `iChannelN` is bound to right now. */
  passChannelTexture(passId: string, channel: number): THREE.Texture | null {
    for (const pass of this.eachPass()) {
      if (pass.id !== passId) continue;
      return (pass.uniforms[CHANNEL_UNIFORMS[channel]]?.value as THREE.Texture) ?? null;
    }
    return null;
  }

  /** The texture holding a buffer's most recently finished frame. */
  bufferTexture(passId: string): THREE.Texture | null {
    return this.targets.front(passId);
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
    channels: ChannelBindings,
  ): Record<string, THREE.IUniform> {
    const T = this.three;

    const uniforms: Record<string, THREE.IUniform> = {
      iTime: { value: this.time },
      iResolution: { value: new T.Vector2(1, 1) },
      iMouse: { value: new T.Vector4(-1000, -1000, 0, 0) },
      iMouseVel: { value: new T.Vector2(0, 0) },
      u_clickData: { value: this.clickData },
    };

    // A placeholder to begin with: a binding to a buffer names a texture that
    // ping-pongs, so there is nothing stable to put here. `bindChannels` fills
    // them in for real, every frame, just before the pass is drawn.
    for (let index = 0; index < CHANNEL_COUNT; index++) {
      uniforms[CHANNEL_UNIFORMS[index]] = {
        value: this.resolveBinding(channels[index]) ?? this.placeholderTexture,
      };
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

  /** Re-apply the control values to a pass whose program was left alone. */
  private applyParams(
    pass: CompiledPass,
    controls: readonly ShaderControl[],
    params: ShaderParams,
  ): void {
    for (const control of controls) {
      const uniform = pass.uniforms[UNIFORM_PREFIX + control.key];
      if (!uniform) continue;

      const value = params[control.key] ?? control.default;
      if (control.type === 'color') (uniform.value as THREE.Color).set(String(value));
      else uniform.value = value;
    }
  }

  /**
   * The texture a binding names, at this instant.
   *
   * `null` for a buffer whose target does not exist yet — the very first frame
   * after a buffer is added, before `syncTargets` has run — which the callers
   * turn into the transparent placeholder rather than a broken bind.
   */
  private resolveBinding(binding: ChannelBindings[number]): THREE.Texture | null {
    switch (binding.kind) {
      case 'texture':
        return this.resolveTexture(this.textureSlots[binding.slot] ?? null);
      case 'buffer':
        return binding.feedback
          ? this.targets.previous(binding.passId)
          : this.targets.front(binding.passId);
      case 'none':
      default:
        return null;
    }
  }

  /**
   * Point a pass's four samplers at the textures its bindings currently name.
   *
   * Done immediately before the pass is drawn, every frame, because that is the
   * only moment at which the answer is knowable: the buffers this pass depends
   * on have by then rendered (the order guarantees it), and the ping-pong has
   * put this frame's result in front — while a feedback binding still reads the
   * snapshot taken before any of it happened.
   */
  private bindChannels(pass: CompiledPass): void {
    for (let index = 0; index < CHANNEL_COUNT; index++) {
      const uniform = pass.uniforms[CHANNEL_UNIFORMS[index]];
      if (!uniform) continue;
      uniform.value = this.resolveBinding(pass.channels[index]) ?? this.placeholderTexture;
    }
  }

  private syncTargets(): void {
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    const offline = this.offline;

    this.targets.sync(
      this.targetSpecs,
      offline
        ? { width: offline.width, height: offline.height }
        : {
            width: width * this.resolutionScale,
            height: height * this.resolutionScale,
          },
    );
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

  /**
   * A control drives the same uniform in every pass that declares it. Turning a
   * knob has to reach the buffers too, or a parameter the whole pipeline is
   * built around would only affect the last step of it.
   */
  setParam(key: string, value: ParamValue): void {
    const control = this.controls.find((entry) => entry.key === key);

    for (const pass of this.eachPass()) {
      const uniform = pass.uniforms[UNIFORM_PREFIX + key];
      if (!uniform) continue;

      if (control?.type === 'color') (uniform.value as THREE.Color).set(String(value));
      else uniform.value = value;
    }
  }

  /** Every live pass: the buffers, then the Image pass. */
  private *eachPass(): Generator<CompiledPass> {
    for (const pass of this.buffers) yield pass;
    if (this.image) yield this.image;
  }

  /**
   * Set a uniform that the engine — not the shader author — owns, on every pass.
   * `iTime` has to tick in a buffer exactly as it does in the Image pass.
   */
  private setBuiltIn(name: string, apply: (uniform: THREE.IUniform) => void): void {
    for (const pass of this.eachPass()) {
      const uniform = pass.uniforms[name];
      if (uniform) apply(uniform);
    }

    // The single-pass path keeps its uniforms in `this.uniforms` without an
    // `image` behind them (a shader set while the context was lost, say).
    if (!this.image) {
      const uniform = this.uniforms[name];
      if (uniform) apply(uniform);
    }
  }

  /**
   * Rebinds iChannel0…3 without touching the compiled program: swapping which
   * image a channel points at (or its wrap/filter/flip) is just a new uniform
   * value, never a reason to recompile.
   *
   * What changes here are the shader's four *image* slots. Which passes sample
   * them, and through which channel, is the project's business and is untouched:
   * a pass bound to `texture 2` keeps sampling slot 2, and simply sees the new
   * image in it on the next frame.
   */
  setChannels(channels: readonly (ChannelSource | null)[]): void {
    if (this.disposed) return;

    this.setTextureSlots(channels);

    // The Image pass in a single-pass shader has no `bindChannels` before it —
    // the buffer loop is what normally does the rebinding — so do it here, which
    // also keeps `channelTexture()` honest the moment this returns.
    if (this.image) this.bindChannels(this.image);
    else {
      for (let index = 0; index < CHANNEL_COUNT; index++) {
        const uniform = this.uniforms[CHANNEL_UNIFORMS[index]];
        if (uniform) {
          uniform.value = this.resolveBinding(this.imageChannels[index]) ?? this.placeholderTexture;
        }
      }
    }
  }

  private setTextureSlots(channels: readonly (ChannelSource | null)[]): void {
    this.textureSlots = [
      channels[0] ?? null,
      channels[1] ?? null,
      channels[2] ?? null,
      channels[3] ?? null,
    ];
    this.pruneTextureCache(this.textureSlots);
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

    // Only the Image pass' resolution is the canvas's. A buffer's is its own
    // target's, and `drawBuffers` sets it from the target it is about to fill.
    const image = this.image?.uniforms ?? this.uniforms;
    const resolution = image['iResolution']?.value as THREE.Vector2 | undefined;
    resolution?.set(width * scale, height * scale);

    // A viewport- or scale-relative buffer is now the wrong size. Re-syncing is
    // guarded inside `BufferTargets`, so a resize that did not actually change a
    // target's dimensions costs nothing — which matters, because a
    // `ResizeObserver` fires far more often than the size really changes, and a
    // reallocation would wipe every feedback buffer's history each time.
    this.targets.sync(this.targetSpecs, { width: width * scale, height: height * scale });
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
    this.setMouse((mouse) => mouse.set(-1000, -1000, 0, 0));
    this.setBuiltIn('iMouseVel', (uniform) => (uniform.value as THREE.Vector2).set(0, 0));
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
    this.setBuiltIn('iTime', (uniform) => (uniform.value = time));

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

    this.setBuiltIn('iTime', (uniform) => (uniform.value = this.time));

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
    this.setMouse((mouse) => mouse.set(position.x, position.y, 1, 0));
    this.spawnRipple(position.x, position.y);
  };

  private readonly onPointerUp = (): void => {
    if (this.offline) return;
    this.setMouse((mouse) => (mouse.z = 0));
  };

  private readonly onPointerLeave = (): void => {
    if (this.offline) return;
    this.pointer.set(-1000, -1000);
    this.pointerVelocity.set(0, 0);
    this.lastPointer = null;
    this.setMouse((mouse) => (mouse.z = 0));
  };

  private readonly onContextMenu = (event: Event): void => event.preventDefault();

  private setMouse(apply: (mouse: THREE.Vector4) => void): void {
    this.setBuiltIn('iMouse', (uniform) => apply(uniform.value as THREE.Vector4));
  }

  /**
   * Ripples live in a fixed ring of slots, oldest overwritten first.
   *
   * Nothing has to be pushed to the passes here: every pass's `u_clickData`
   * uniform holds *the same* array of vectors — the engine's — so writing into a
   * slot is already visible to all of them.
   */
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

    // The render targets are husks: the textures behind them died with the
    // context. Rebuilt at the size they had — empty, because their contents are
    // genuinely gone, which for a feedback buffer means its history restarts.
    this.targets.invalidate(this.targetSpecs);

    // Every program the driver held is gone too. Forgetting the compiled passes
    // is what stops `setPasses` recognising their sources as unchanged and
    // "reusing" materials that no longer exist on the GPU.
    this.buffers = [];
    this.image = null;

    const spec = this.lastSpec;
    if (spec) this.setPasses(spec);
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

      this.setBuiltIn('iTime', (uniform) => (uniform.value = this.time));

      this.setBuiltIn('iMouse', (uniform) => {
        const mouse = uniform.value as THREE.Vector4;
        mouse.x = this.pointer.x;
        mouse.y = this.pointer.y;
      });
      this.setBuiltIn('iMouseVel', (uniform) =>
        (uniform.value as THREE.Vector2).copy(this.pointerVelocity),
      );
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

  /**
   * One frame: every buffer, in dependency order, into its own target — then the
   * Image pass onto the canvas.
   *
   * The order came from the graph, so by the time a pass is drawn everything it
   * samples without feedback has already been drawn this frame. The snapshot
   * taken by `beginFrame` is what the feedback bindings read, and it is taken
   * before any of this, so "the previous frame" means the same thing to every
   * pass regardless of where its owner sits in the order.
   */
  private draw(): void {
    if (this.disposed || this.context.status() !== 'live') return;

    this.drawBuffers();

    if (this.image) this.bindChannels(this.image);

    if (this.render.bloom.enabled && this.composer) {
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  private drawBuffers(): void {
    if (this.buffers.length === 0) return;

    this.targets.beginFrame();

    const previousTarget = this.renderer.getRenderTarget();

    for (const pass of this.buffers) {
      const target = this.targets.write(pass.id);
      if (!target) continue;

      this.bindChannels(pass);

      // A buffer's `iResolution` is *its* target's size, not the canvas's. A
      // half-resolution buffer that thought it was full-size would sample and
      // step at the wrong scale, which is the sort of thing that looks like a
      // shader bug for an hour.
      const size = this.targets.size(pass.id);
      const resolution = pass.uniforms['iResolution']?.value as THREE.Vector2 | undefined;
      if (size && resolution) resolution.set(size.width, size.height);

      this.bufferMesh.material = pass.material;
      this.renderer.setRenderTarget(target);
      this.renderer.render(this.bufferScene, this.camera);

      // What was just drawn becomes the buffer's current frame, and the target
      // holding the frame before it becomes the one we draw into next time.
      this.targets.swap(pass.id);
    }

    this.renderer.setRenderTarget(previousTarget);
    this.bufferMesh.material = this.material;
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
    this.targets.dispose();

    // The Image pass's material *is* `this.material`, so dispose the buffers and
    // then it — once each.
    for (const pass of this.buffers) pass.material.dispose();
    this.buffers = [];
    this.image = null;

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
