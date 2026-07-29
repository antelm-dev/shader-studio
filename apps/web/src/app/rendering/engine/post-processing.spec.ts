import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RenderSettings } from '@shader-studio/shared';
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
}

const fakeModules = {
  EffectComposer: FakeComposer,
  RenderPass: FakeRenderPass,
  UnrealBloomPass: FakeBloomPass,
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
 * A loader that suspends until `resolve()` is called, letting the test
 * precisely control when the dynamic import completes.
 */
function deferredLoader(): {
  load: () => Promise<PostProcessingModules>;
  calls: number;
  resolve: () => Promise<void>;
} {
  let pending: (() => void) | null = null;
  const state = {
    calls: 0,
    load: () => {
      state.calls++;
      return new Promise<PostProcessingModules>((res) => {
        pending = () => res(fakeModules);
      });
    },
    resolve: async () => {
      pending?.();
      pending = null;
      // Two microtask turns: one to settle the loader promise, one for the
      // `.then` inside ensureComposer/setSettings.
      await Promise.resolve();
      await Promise.resolve();
    },
  };
  return state;
}

function settings(overrides: Partial<RenderSettings['bloom']> = {}): RenderSettings {
  return { bloom: { enabled: true, strength: 0.3, radius: 0.5, threshold: 0.85, ...overrides } };
}

const OFF = settings({ enabled: false });

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

    p.setSettings(settings({ strength: 1.5 })); // triggers load
    p.invalidate(); // stale
    await deferred.resolve(); // discarded

    p.restore(); // starts a fresh load
    await deferred.resolve(); // this one is valid

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

    p.setSettings(settings({ strength: 0.1 })); // load #1 starts
    p.setSettings(OFF); // invalidates load #1 generation
    p.setSettings(settings({ strength: 0.9 })); // load #2 starts — but same loader

    // Resolve both pending calls in order: first the old one, then the current.
    await d1.resolve(); // first call resolves — must be silently dropped
    await d1.resolve(); // second call resolves — should install

    // Only the second (valid) call should have produced a composer.
    expect(FakeComposer.created).toBe(1);
    expect((FakeComposer.last().passes[1] as FakeBloomPass).strength).toBe(0.9);

    p.dispose();
  });
});
