import { vi } from 'vitest';

import type { GlBackend, ThreeModule } from '../gl-context';

/**
 * A three.js that never touches a GPU.
 *
 * jsdom has no WebGL, and a real driver would make the answers
 * non-deterministic anyway — but almost nothing worth testing about the
 * renderer is *pixels*. Ownership, isolation, context loss, whether the clock is
 * the wall's or the caller's, what size the drawing buffer was set to: all of it
 * is bookkeeping, and bookkeeping is exactly what a fake can record.
 *
 * So three comes in through the `GlBackend` seam as this, and the fakes remember
 * what was asked of them.
 */

export class FakeVector {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
    public w = 0,
  ) {}
  set(x: number, y: number, z = 0, w = 0): this {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
    return this;
  }
  copy(other: FakeVector): this {
    return this.set(other.x, other.y, other.z, other.w);
  }
  clone(): FakeVector {
    return new FakeVector(this.x, this.y, this.z, this.w);
  }
  lerp(): this {
    return this;
  }
  subVectors(): this {
    return this;
  }
  divideScalar(): this {
    return this;
  }
  multiplyScalar(): this {
    return this;
  }
}

export class FakeDisposable {
  disposed = false;
  dispose(): void {
    this.disposed = true;
  }
}

export class FakeTexture extends FakeDisposable {
  needsUpdate = false;
  wrapS = 0;
  wrapT = 0;
  magFilter = 0;
  minFilter = 0;
  generateMipmaps = true;
  flipY = true;
  constructor(readonly url = '') {
    super();
  }
}

export class FakeMaterial extends FakeDisposable {
  vertexShader: string;
  fragmentShader: string;
  uniforms: Record<string, { value: unknown }>;
  constructor(options: {
    vertexShader: string;
    fragmentShader: string;
    uniforms: Record<string, { value: unknown }>;
  }) {
    super();
    this.vertexShader = options.vertexShader;
    this.fragmentShader = options.fragmentShader;
    this.uniforms = options.uniforms;
  }
}

export class FakeRenderer {
  readonly debug = { checkShaderErrors: false, onShaderError: null as unknown };
  disposed = false;
  draws = 0;

  /** The last drawing-buffer size asked for, and every one before it. */
  pixelRatio = 1;
  width = 0;
  height = 0;
  readonly sizes: { width: number; height: number; pixelRatio: number }[] = [];

  private target: unknown = null;

  setPixelRatio(ratio: number): void {
    this.pixelRatio = ratio;
  }
  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.sizes.push({ width, height, pixelRatio: this.pixelRatio });
  }
  getRenderTarget(): unknown {
    return this.target;
  }
  setRenderTarget(target: unknown): void {
    this.target = target;
  }
  render(): void {
    this.draws++;
  }
  dispose(): void {
    this.disposed = true;
  }
}

export const fakeThree = {
  Scene: class {
    add(): void {}
  },
  OrthographicCamera: class {},
  Mesh: class {
    constructor(
      public geometry: unknown,
      public material: unknown,
    ) {}
  },
  PlaneGeometry: FakeDisposable,
  ShaderMaterial: FakeMaterial,
  WebGLRenderTarget: FakeDisposable,
  DataTexture: class extends FakeTexture {},
  TextureLoader: class {
    load(url: string): FakeTexture {
      return new FakeTexture(url);
    }
  },
  Vector2: FakeVector,
  Vector3: FakeVector,
  Vector4: FakeVector,
  Color: class {
    set(): void {}
  },
  ColorManagement: { enabled: true },
  RGBAFormat: 1023,
  RepeatWrapping: 1000,
  MirroredRepeatWrapping: 1002,
  ClampToEdgeWrapping: 1001,
  NearestFilter: 1003,
  LinearFilter: 1006,
};

/** A backend, plus every renderer it handed out, in creation order. */
export function fakeBackend(): { backend: GlBackend; renderers: FakeRenderer[] } {
  const renderers: FakeRenderer[] = [];
  const backend: GlBackend = {
    three: fakeThree as unknown as ThreeModule,
    createRenderer: () => {
      const renderer = new FakeRenderer();
      renderers.push(renderer);
      return renderer as unknown as ReturnType<GlBackend['createRenderer']>;
    },
  };
  return { backend, renderers };
}

// -----------------------------------------------------------------------------
// A controllable animation frame
// -----------------------------------------------------------------------------

/**
 * `requestAnimationFrame` under the test's control.
 *
 * The engine's whole liveness — and, for a capture, its whole *deadness* — is
 * expressed in whether it has a frame scheduled. Owning the queue is what lets a
 * test say "run one round" and then ask who drew.
 */
export class FakeFrames {
  private frames = new Map<number, FrameRequestCallback>();
  private nextFrame = 0;

  install(): void {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++this.nextFrame;
      this.frames.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      this.frames.delete(id);
    });
  }

  /** Whether anything is still asking to be drawn. */
  get pending(): number {
    return this.frames.size;
  }

  /** Runs exactly one round of whatever the engines have scheduled. */
  run(): void {
    const pending = [...this.frames.values()];
    this.frames.clear();
    for (const callback of pending) callback(performance.now());
  }
}
