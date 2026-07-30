import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  BloomSettings,
  PostProcessingEffect,
  RenderSettings,
  VignetteSettings,
} from '@shader-studio/shared';
import { GlContext } from '../gl-context';
import { FakeRenderer, FakeScene, fakeBackend } from '../testing/fake-gl';
import { PostProcessing, type PostProcessingModules } from './post-processing';

/**
 * Bloom, and the decision the rest of the engine is not allowed to see.
 *
 * The real `EffectComposer` allocates render targets in its constructor, which
 * needs a GPU jsdom does not have — so the post-processing classes come in
 * through the loader seam as fakes, the same way three itself comes in through
 * `GlBackend`. What is under test is not what bloom looks like; it is *when* the
 * chain is built, when it is torn down, and which of the two paths a frame took.
 */

class FakeComposer {
  /**
   * Every composer ever built, newest last. A test cannot ask `PostProcessing`
   * whether it has one — that is the whole point of the type — so the fake
   * records it instead.
   */
  static readonly instances: FakeComposer[] = [];

  static reset(): void {
    FakeComposer.instances.length = 0;
  }

  static get created(): number {
    return FakeComposer.instances.length;
  }

  static last(): FakeComposer {
    const composer = FakeComposer.instances.at(-1);
    if (!composer) throw new Error('No composer was ever created.');
    return composer;
  }

  readonly passes: unknown[] = [];
  renders = 0;
  disposed = false;
  pixelRatio = 1;
  width = 0;
  height = 0;

  constructor(readonly renderer: unknown) {
    FakeComposer.instances.push(this);
  }

  addPass(pass: unknown): void {
    this.passes.push(pass);
  }
  render(): void {
    this.renders++;
  }
  setPixelRatio(ratio: number): void {
    this.pixelRatio = ratio;
  }
  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }
  dispose(): void {
    this.disposed = true;
  }
}

class FakeRenderPass {
  constructor(
    readonly scene: unknown,
    readonly camera: unknown,
  ) {}
}

class FakeBloomPass {
  width = 0;
  height = 0;
  disposed = false;

  constructor(
    readonly resolution: unknown,
    public strength: number,
    public radius: number,
    public threshold: number,
  ) {}

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** Stands in for `ShaderPass` — the real one is what Vignette rides on. */
class FakeShaderPass {
  disposed = false;
  readonly uniforms: Record<string, { value: unknown }>;

  constructor(shader: { uniforms: Record<string, { value: unknown }> }) {
    this.uniforms = Object.fromEntries(
      Object.entries(shader.uniforms).map(([key, uniform]) => [key, { value: uniform.value }]),
    );
  }

  dispose(): void {
    this.disposed = true;
  }
}

const fakeModules = {
  EffectComposer: FakeComposer,
  RenderPass: FakeRenderPass,
  UnrealBloomPass: FakeBloomPass,
  ShaderPass: FakeShaderPass,
} as unknown as PostProcessingModules;

/** A loader whose promise the test resolves, so "the import is in flight" is a state. */
function controllableLoader(): {
  load: () => Promise<PostProcessingModules>;
  calls: number;
  flush: () => Promise<void>;
} {
  const state = {
    calls: 0,
    load: () => {
      state.calls++;
      return Promise.resolve(fakeModules);
    },
    // Two turns: one for the loader's promise, one for the `.then` that pushes
    // the bloom settings through after it.
    flush: async () => {
      await Promise.resolve();
      await Promise.resolve();
    },
  };
  return state;
}

/**
 * A loader that suspends each call until the corresponding `resolve(n)` is
 * invoked, letting the test precisely control when each dynamic import
 * completes. Resolvers are stored in a FIFO queue keyed by call index.
 */
function deferredLoader(): {
  load: () => Promise<PostProcessingModules>;
  calls: number;
  /** Settle the n-th load call (0-based). Defaults to 0. */
  resolve: (index?: number) => Promise<void>;
} {
  const resolvers: Array<() => void> = [];
  const state = {
    calls: 0,
    load: () => {
      state.calls++;
      return new Promise<PostProcessingModules>((res) => {
        resolvers.push(() => res(fakeModules));
      });
    },
    resolve: async (index = 0) => {
      resolvers[index]?.();
      // Two microtask turns: one to settle the loader promise, one for the
      // .then continuation inside ensureComposer / setSettings.
      await Promise.resolve();
      await Promise.resolve();
    },
  };
  return state;
}

/**
 * Builds a `RenderSettings` whose chain has one Bloom effect. `enabled`
 * toggles the effect itself; `masterEnabled` toggles the chain's master
 * switch — the two are deliberately independent knobs, since either one off
 * takes the direct-render path.
 */
function settings(
  overrides: Partial<BloomSettings> & { enabled?: boolean; masterEnabled?: boolean } = {},
): RenderSettings {
  const { enabled = true, masterEnabled = true, ...bloomOverrides } = overrides;
  return {
    postProcessing: {
      enabled: masterEnabled,
      effects: [
        {
          type: 'bloom',
          enabled,
          settings: { strength: 0.3, radius: 0.5, threshold: 0.85, ...bloomOverrides },
        },
      ],
    },
  };
}

const OFF = settings({ enabled: false });

/** A `RenderSettings` whose chain has one enabled Vignette effect. */
function vignetteSettings(
  overrides: Partial<VignetteSettings> & { enabled?: boolean } = {},
): RenderSettings {
  const { enabled = true, ...vignetteOverrides } = overrides;
  return {
    postProcessing: {
      enabled: true,
      effects: [
        {
          type: 'vignette',
          enabled,
          settings: { intensity: 0.4, softness: 0.5, roundness: 1, ...vignetteOverrides },
        },
      ],
    },
  };
}

/** A chain in the exact effect order given, every entry enabled. */
function chain(...effects: PostProcessingEffect[]): RenderSettings {
  return { postProcessing: { enabled: true, effects } };
}

function bloomEffect(overrides: Partial<BloomSettings> = {}): PostProcessingEffect {
  return {
    type: 'bloom',
    enabled: true,
    settings: { strength: 0.3, radius: 0.5, threshold: 0.85, ...overrides },
  };
}

function vignetteEffect(overrides: Partial<VignetteSettings> = {}): PostProcessingEffect {
  return {
    type: 'vignette',
    enabled: true,
    settings: { intensity: 0.4, softness: 0.5, roundness: 1, ...overrides },
  };
}

describe('PostProcessing', () => {
  let context: GlContext;
  let renderer: FakeRenderer;
  let scene: FakeScene;
  let camera: object;
  let loader: ReturnType<typeof controllableLoader>;
  let post: PostProcessing;

  const create = (): PostProcessing =>
    new PostProcessing(
      context,
      scene as never,
      camera as never,
      loader.load as unknown as () => Promise<PostProcessingModules>,
    );

  beforeEach(async () => {
    FakeComposer.reset();

    const { backend, renderers } = fakeBackend();
    context = await GlContext.create(document.createElement('canvas'), {
      id: 'post',
      backend,
    });
    renderer = renderers[0];

    scene = new FakeScene();
    camera = {};
    loader = controllableLoader();
    post = create();
  });

  afterEach(() => {
    post.dispose();
    context.dispose();
  });

  // ---------------------------------------------------------------------------
  // The path a frame takes
  // ---------------------------------------------------------------------------

  it('draws straight at the canvas, and downloads nothing, while bloom is off', async () => {
    post.setSettings(OFF);
    await loader.flush();

    post.render(scene as never, camera as never);

    expect(loader.calls).toBe(0);
    expect(FakeComposer.created).toBe(0);
    expect(renderer.draws).toBe(1);
    expect(renderer.drawLog[0].scene).toBe(scene);
  });

  it('takes the direct path when the master switch is off, even with bloom individually enabled', async () => {
    post.setSettings(settings({ masterEnabled: false }));
    await loader.flush();

    post.render(scene as never, camera as never);

    expect(loader.calls).toBe(0);
    expect(FakeComposer.created).toBe(0);
    expect(renderer.draws).toBe(1);
  });

  it('builds the chain on the first settings that ask for bloom, then renders through it', async () => {
    post.setSettings(settings());

    // The import is in flight: there is nothing to render through yet, so the
    // frame still reaches the canvas directly rather than being dropped.
    post.render(scene as never, camera as never);
    expect(renderer.draws).toBe(1);

    await loader.flush();

    expect(loader.calls).toBe(1);
    expect(FakeComposer.created).toBe(1);

    post.render(scene as never, camera as never);
    expect(renderer.draws).toBe(1);
  });

  it('gives the composer a render pass for the scene it was constructed with', async () => {
    post.setSettings(settings());
    await loader.flush();

    const composer = FakeComposer.last();
    const [render, bloom] = composer.passes as [FakeRenderPass, FakeBloomPass];

    expect(composer.renderer).toBe(renderer);
    expect(render.scene).toBe(scene);
    expect(render.camera).toBe(camera);
    expect(bloom.strength).toBe(0.3);
  });

  it('asks to be sized once a composer exists, since the resize that mattered is long gone', async () => {
    const created = vi.fn();
    post.onComposerCreated = created;

    post.setSettings(settings());
    expect(created).not.toHaveBeenCalled();

    await loader.flush();
    expect(created).toHaveBeenCalledTimes(1);
  });

  it('reports only actual direct/composer render-path transitions', async () => {
    const changed = vi.fn();
    post.onRenderPathChanged = changed;

    post.setSettings(settings());
    expect(changed).not.toHaveBeenCalled();

    await loader.flush();
    expect(changed).toHaveBeenCalledTimes(1);

    post.setSettings(settings({ strength: 1.2 }));
    await loader.flush();
    expect(changed).toHaveBeenCalledTimes(1);

    post.setSettings(OFF);
    expect(changed).toHaveBeenCalledTimes(2);

    post.setSettings(OFF);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  // ---------------------------------------------------------------------------
  // Live updates
  // ---------------------------------------------------------------------------

  it('pushes new bloom values through without rebuilding anything', async () => {
    post.setSettings(settings());
    await loader.flush();

    const composer = FakeComposer.last();

    post.setSettings(settings({ strength: 1.4, radius: 0.9, threshold: 0.2 }));
    await loader.flush();

    const bloom = composer.passes[1] as FakeBloomPass;
    expect(bloom.strength).toBe(1.4);
    expect(bloom.radius).toBe(0.9);
    expect(bloom.threshold).toBe(0.2);

    // A slider drag is a uniform change, not an allocation.
    expect(FakeComposer.created).toBe(1);
    expect(loader.calls).toBe(1);
    expect(composer.disposed).toBe(false);
  });

  it('sizes the composer in buffer units and bloom in real pixels', async () => {
    post.setSettings(settings());
    await loader.flush();

    const composer = FakeComposer.last();

    post.setSize(800, 600, 2);

    expect(composer.pixelRatio).toBe(2);
    expect(composer.width).toBe(800);
    expect(composer.height).toBe(600);

    const bloom = composer.passes[1] as FakeBloomPass;
    expect(bloom.width).toBe(1600);
    expect(bloom.height).toBe(1200);
  });

  it('accepts a size with no composer at all', () => {
    expect(() => post.setSize(800, 600, 1)).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------

  it('frees the chain when bloom is switched off, rather than leaving it bypassed', async () => {
    post.setSettings(settings());
    await loader.flush();
    const composer = FakeComposer.last();

    post.setSettings(OFF);

    expect(composer.disposed).toBe(true);

    const draws = renderer.draws;
    post.render(scene as never, camera as never);
    expect(renderer.draws).toBe(draws + 1);
  });

  it('switches bloom off and on again, building a second chain', async () => {
    post.setSettings(settings());
    await loader.flush();
    post.setSettings(OFF);

    post.setSettings(settings({ strength: 0.8 }));
    await loader.flush();

    expect(FakeComposer.created).toBe(2);
    const bloom = FakeComposer.last().passes[1] as FakeBloomPass;
    expect(bloom.strength).toBe(0.8);
  });

  it('drops the chain on a lost context and rebuilds it on restore', async () => {
    post.setSettings(settings({ strength: 1.1 }));
    await loader.flush();
    const first = FakeComposer.last();

    post.invalidate();

    expect(first.disposed).toBe(true);
    // The husk is gone, so a frame drawn between loss and restore goes direct.
    const draws = renderer.draws;
    post.render(scene as never, camera as never);
    expect(renderer.draws).toBe(draws + 1);

    post.restore();
    await loader.flush();

    const second = FakeComposer.last();
    expect(second).not.toBe(first);
    // Restored to the settings in force, not to the defaults.
    expect((second.passes[1] as FakeBloomPass).strength).toBe(1.1);
  });

  it('restores to direct rendering when bloom was off when the context died', async () => {
    post.setSettings(OFF);
    post.invalidate();
    post.restore();
    await loader.flush();

    expect(FakeComposer.created).toBe(0);
  });

  it('disposes repeatedly without complaint, and never after that', async () => {
    post.setSettings(settings());
    await loader.flush();
    const composer = FakeComposer.last();

    post.dispose();
    post.dispose();

    expect(composer.disposed).toBe(true);

    // An engine torn down while bloom is being switched on must not leave a
    // composer — and its render targets — behind it.
    post.setSettings(settings());
    await loader.flush();
    expect(FakeComposer.created).toBe(1);
  });

  it('throws away a composer whose import landed after disposal', async () => {
    post.setSettings(settings());
    post.dispose();
    await loader.flush();

    expect(FakeComposer.created).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Race: disable-before-resolution
  // ---------------------------------------------------------------------------

  it('creates no composer when bloom is disabled before the loader resolves', async () => {
    const deferred = deferredLoader();
    const p = new PostProcessing(
      context,
      scene as never,
      camera as never,
      deferred.load as unknown as () => Promise<PostProcessingModules>,
    );

    p.setSettings(settings()); // triggers load — loader is now pending
    p.setSettings(OFF); // disable before import resolves

    await deferred.resolve(); // let the import land

    expect(FakeComposer.created).toBe(0);

    p.dispose();
  });

  // ---------------------------------------------------------------------------
  // Race: invalidate-before-resolution
  // ---------------------------------------------------------------------------

  it('creates no stale composer when the context is invalidated before the loader resolves', async () => {
    const deferred = deferredLoader();
    const p = new PostProcessing(
      context,
      scene as never,
      camera as never,
      deferred.load as unknown as () => Promise<PostProcessingModules>,
    );

    p.setSettings(settings()); // triggers load — loader is now pending
    p.invalidate(); // context lost before import resolves

    await deferred.resolve(); // late arrival — must be discarded

    expect(FakeComposer.created).toBe(0);

    p.dispose();
  });

  it('builds exactly one fresh composer on restore after an invalidated-in-flight load', async () => {
    const deferred = deferredLoader();
    const p = new PostProcessing(
      context,
      scene as never,
      camera as never,
      deferred.load as unknown as () => Promise<PostProcessingModules>,
    );

    p.setSettings(settings({ strength: 1.5 })); // triggers load (index 0)
    p.invalidate(); // stale — bumps generation
    await deferred.resolve(0); // discarded: generation mismatch

    p.restore(); // starts a fresh load (index 1)
    await deferred.resolve(1); // this one is valid

    expect(FakeComposer.created).toBe(1);
    expect((FakeComposer.last().passes[1] as FakeBloomPass).strength).toBe(1.5);

    p.dispose();
  });

  // ---------------------------------------------------------------------------
  // Race: rapid settings updates
  // ---------------------------------------------------------------------------

  it('rapid enable/disable cycles cannot let an older completion overwrite the current state', async () => {
    const d1 = deferredLoader();
    const p = new PostProcessing(
      context,
      scene as never,
      camera as never,
      d1.load as unknown as () => Promise<PostProcessingModules>,
    );

    p.setSettings(settings({ strength: 0.1 })); // load #1 starts (index 0)
    p.setSettings(OFF); // invalidates load #1 generation
    p.setSettings(settings({ strength: 0.9 })); // load #2 starts (index 1)

    // Resolve in call order: old one first, then the current.
    await d1.resolve(0); // first call resolves — must be silently dropped
    await d1.resolve(1); // second call resolves — should install

    // Only the second (valid) call should have produced a composer.
    expect(FakeComposer.created).toBe(1);
    expect((FakeComposer.last().passes[1] as FakeBloomPass).strength).toBe(0.9);

    p.dispose();
  });

  // ---------------------------------------------------------------------------
  // Race: out-of-order resolution — newer settles first
  // ---------------------------------------------------------------------------

  it('newer enable request settles first and installs settings B; older settling after cannot overwrite', async () => {
    const deferred = deferredLoader();
    const p = new PostProcessing(
      context,
      scene as never,
      camera as never,
      deferred.load as unknown as () => Promise<PostProcessingModules>,
    );

    // Load A (index 0) starts, then load B (index 1) starts.
    p.setSettings(settings({ strength: 0.2 })); // A
    p.setSettings(settings({ strength: 0.8 })); // B — ensureComposer returns early (composer already pending)

    // Resolve B first (index 1).
    await deferred.resolve(1);

    expect(FakeComposer.created).toBe(1);
    const bloom = FakeComposer.last().passes[1] as FakeBloomPass;
    // The composer was just created; the B continuation ran and wrote 0.8.
    expect(bloom.strength).toBe(0.8);

    // Now resolve A (index 0) — its continuation must not overwrite B's values.
    await deferred.resolve(0);

    expect(FakeComposer.created).toBe(1); // still only one composer
    expect(bloom.strength).toBe(0.8); // not 0.2

    p.dispose();
  });

  it('two enabled-setting updates resolving out of order converge on the latest values', async () => {
    const deferred = deferredLoader();
    const p = new PostProcessing(
      context,
      scene as never,
      camera as never,
      deferred.load as unknown as () => Promise<PostProcessingModules>,
    );

    // Composer already exists from a prior enable.
    p.setSettings(settings({ strength: 0.3 }));
    await deferred.resolve(0); // load #1 resolves — composer created
    expect(FakeComposer.created).toBe(1);

    // Two successive updates — both re-use the existing composer.
    p.setSettings(settings({ strength: 0.5 })); // update A (no new load needed)
    p.setSettings(settings({ strength: 0.9 })); // update B (no new load needed)

    // Both continuations resolve synchronously since ensureComposer returns early.
    await Promise.resolve();
    await Promise.resolve();

    const bloom = FakeComposer.last().passes[1] as FakeBloomPass;
    expect(bloom.strength).toBe(0.9);
    expect(FakeComposer.created).toBe(1);

    p.dispose();
  });
});

describe('Vignette and multi-effect ordering', () => {
  let context: GlContext;
  let renderer: FakeRenderer;
  let scene: FakeScene;
  let camera: object;
  let loader: ReturnType<typeof controllableLoader>;
  let post: PostProcessing;

  const create = (): PostProcessing =>
    new PostProcessing(
      context,
      scene as never,
      camera as never,
      loader.load as unknown as () => Promise<PostProcessingModules>,
    );

  beforeEach(async () => {
    FakeComposer.reset();

    const { backend, renderers } = fakeBackend();
    context = await GlContext.create(document.createElement('canvas'), {
      id: 'post-vignette',
      backend,
    });
    renderer = renderers[0];

    scene = new FakeScene();
    camera = {};
    loader = controllableLoader();
    post = create();
  });

  afterEach(() => {
    post.dispose();
    context.dispose();
  });

  it('builds a Vignette-only composer with alpha-preserving, resolution-independent uniforms', async () => {
    post.setSettings(vignetteSettings({ intensity: 0.6, softness: 0.2, roundness: 0.8 }));
    await loader.flush();

    const composer = FakeComposer.last();
    const [render, vignette] = composer.passes as [FakeRenderPass, FakeShaderPass];

    expect(render.scene).toBe(scene);
    expect(vignette.uniforms['uIntensity'].value).toBe(0.6);
    expect(vignette.uniforms['uSoftness'].value).toBe(0.2);
    expect(vignette.uniforms['uRoundness'].value).toBe(0.8);

    post.render(scene as never, camera as never);
    expect(renderer.draws).toBe(0); // drew through the composer, not the direct path
  });

  it('builds the composer with passes in the chain order given: Vignette before Bloom', async () => {
    post.setSettings(chain(vignetteEffect(), bloomEffect()));
    await loader.flush();

    const [, vignette, bloom] = FakeComposer.last().passes as [
      FakeRenderPass,
      FakeShaderPass,
      FakeBloomPass,
    ];
    expect(vignette).toBeInstanceOf(FakeShaderPass);
    expect(bloom).toBeInstanceOf(FakeBloomPass);
  });

  it('rebuilds with the new order when the chain is reordered', async () => {
    post.setSettings(chain(bloomEffect(), vignetteEffect()));
    await loader.flush();
    const first = FakeComposer.last();
    expect(first.passes[1]).toBeInstanceOf(FakeBloomPass);
    expect(first.passes[2]).toBeInstanceOf(FakeShaderPass);

    post.setSettings(chain(vignetteEffect(), bloomEffect()));
    await loader.flush();

    expect(FakeComposer.created).toBe(2);
    expect(first.disposed).toBe(true); // the stale order was freed, not left bypassed
    const second = FakeComposer.last();
    expect(second.passes[1]).toBeInstanceOf(FakeShaderPass);
    expect(second.passes[2]).toBeInstanceOf(FakeBloomPass);
  });

  it('pushes Vignette values through without rebuilding when only settings change', async () => {
    post.setSettings(vignetteSettings({ intensity: 0.2 }));
    await loader.flush();
    const composer = FakeComposer.last();

    post.setSettings(vignetteSettings({ intensity: 0.9, softness: 0.7, roundness: 0.1 }));

    const vignette = composer.passes[1] as FakeShaderPass;
    expect(vignette.uniforms['uIntensity'].value).toBe(0.9);
    expect(vignette.uniforms['uSoftness'].value).toBe(0.7);
    expect(vignette.uniforms['uRoundness'].value).toBe(0.1);
    expect(FakeComposer.created).toBe(1);
    expect(composer.disposed).toBe(false);
  });

  it('rebuilds — rather than leaving a mismatched composer bypassed — when a second effect is enabled', async () => {
    post.setSettings(chain(bloomEffect()));
    await loader.flush();
    const first = FakeComposer.last();

    post.setSettings(chain(bloomEffect(), vignetteEffect()));
    await loader.flush();

    expect(first.disposed).toBe(true);
    expect(FakeComposer.created).toBe(2);
    expect(FakeComposer.last().passes).toHaveLength(3); // render + bloom + vignette
  });

  it('rebuilds down to the remaining effect when one is disabled from a two-effect chain', async () => {
    post.setSettings(chain(bloomEffect(), vignetteEffect()));
    await loader.flush();

    post.setSettings(chain(bloomEffect(), { ...vignetteEffect(), enabled: false }));
    await loader.flush();

    const composer = FakeComposer.last();
    expect(composer.passes).toHaveLength(2); // render + bloom only
    expect(composer.passes[1]).toBeInstanceOf(FakeBloomPass);
  });

  it('takes the direct path when the master switch is off, even with a full two-effect chain', async () => {
    post.setSettings({
      postProcessing: { enabled: false, effects: [bloomEffect(), vignetteEffect()] },
    });
    await loader.flush();

    post.render(scene as never, camera as never);

    expect(FakeComposer.created).toBe(0);
    expect(renderer.draws).toBe(1);
  });

  it('disposes every built pass, not just the composer, on teardown', async () => {
    post.setSettings(chain(bloomEffect(), vignetteEffect()));
    await loader.flush();

    const [, bloom, vignette] = FakeComposer.last().passes as [
      FakeRenderPass,
      FakeBloomPass,
      FakeShaderPass,
    ];
    post.dispose();

    expect(bloom.disposed).toBe(true);
    expect(vignette.disposed).toBe(true);
  });
});
