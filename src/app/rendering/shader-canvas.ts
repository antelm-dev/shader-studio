import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import { Preferences } from '../core/preferences';
import { ShaderStore } from '../core/shader-store';
import { RendererHandle } from './renderer-handle';
import { ShaderEngine } from './shader-engine';

/** How long to wait after the last keystroke before recompiling. */
const RECOMPILE_DEBOUNCE_MS = 400;

/**
 * The application's background: a full-viewport canvas rendering the selected
 * shader, with everything else painted on top of it.
 *
 * This is the only place that connects the store to the engine, and it does so
 * with one effect per concern:
 *
 *   source + schema -> recompile (debounced; a recompile is expensive)
 *   parameters      -> write uniforms (cheap; every frame of a slider drag)
 *   render settings -> post-processing
 *   preferences     -> pause, resolution
 *
 * Separating them is what stops a colour picker from recompiling the shader.
 */
@Component({
  selector: 'app-shader-canvas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<canvas #canvas class="shader-canvas" aria-hidden="true"></canvas>`,
  styles: `
    :host {
      position: fixed;
      inset: 0;
      z-index: 0;
      display: block;
      background: #0a0c10;
    }

    .shader-canvas {
      display: block;
      width: 100%;
      height: 100%;
      touch-action: none;
    }
  `,
})
export class ShaderCanvas {
  private readonly store = inject(ShaderStore);
  private readonly preferences = inject(Preferences);
  private readonly handle = inject(RendererHandle);
  private readonly destroyRef = inject(DestroyRef);

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly engine = signal<ShaderEngine | null>(null);

  /** The source as typed. Recompiling on every keystroke would be unusable. */
  private readonly source = computed(() => {
    const draft = this.store.draft();
    return draft ? { fragment: draft.fragment, vertex: draft.vertex } : null;
  });

  private readonly debouncedSource = signal<{ fragment: string; vertex: string } | null>(null);

  constructor() {
    afterNextRender(() => {
      void this.boot();
    });

    // Debounce the source, but only in the browser: `afterNextRender` guards
    // the engine, and a timer on the server would never be cleared.
    effect((onCleanup) => {
      const source = this.source();
      if (!source) {
        this.debouncedSource.set(null);
        return;
      }
      const timer = setTimeout(() => this.debouncedSource.set(source), RECOMPILE_DEBOUNCE_MS);
      onCleanup(() => clearTimeout(timer));
    });

    // Compile. Params and render settings are read untracked: they have their
    // own effects, and changing them must not trigger a recompile.
    effect(() => {
      const engine = this.engine();
      const source = this.debouncedSource();
      const controls = this.store.controls();
      if (!engine || !source) return;

      untracked(() => {
        const draft = this.store.draft();
        const diagnostics = engine.setShader({
          fragment: source.fragment,
          vertex: source.vertex,
          controls,
          params: this.store.params(),
          render: draft?.render ?? { bloom: { enabled: false, strength: 0, radius: 0, threshold: 1 } },
        });
        this.store.setCompileDiagnostics(diagnostics);
      });
    });

    effect(() => {
      const engine = this.engine();
      const params = this.store.params();
      engine?.setParams(params);
    });

    effect(() => {
      const engine = this.engine();
      const render = this.store.draft()?.render;
      if (engine && render) engine.setRenderSettings(render);
    });

    effect(() => {
      const engine = this.engine();
      const { paused, resolutionScale, autoRipples } = this.preferences.value();
      if (!engine) return;
      engine.setPaused(paused);
      engine.setResolutionScale(resolutionScale);
      engine.setAutoRipples(autoRipples);
    });
  }

  private async boot(): Promise<void> {
    const canvas = this.canvasRef().nativeElement;

    let engine: ShaderEngine;
    try {
      engine = await ShaderEngine.create(canvas);
    } catch (error) {
      // No WebGL: the app is still usable as an editor, so say so and move on.
      this.store.notice.set({
        text: `WebGL is unavailable, so the preview is disabled: ${String(error)}`,
        error: true,
      });
      return;
    }

    engine.onFps = (fps) => this.handle.fps.set(fps);
    this.engine.set(engine);
    this.handle.engine.set(engine);

    const observer = new ResizeObserver(() => engine.resize());
    observer.observe(canvas);

    this.destroyRef.onDestroy(() => {
      observer.disconnect();
      this.handle.engine.set(null);
      engine.dispose();
    });
  }
}
