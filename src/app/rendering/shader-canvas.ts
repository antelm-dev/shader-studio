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
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';

import { composePass } from '@shader-studio/shared/pass-source';
import {
  COLOR_SCHEME_OPTIONS,
  Preferences,
  colorSchemeIcon,
  type ColorScheme,
  type WorkspacePreferences,
} from '../core/preferences';
import { DesktopPlatform } from '../core/desktop-platform';
import type { CompileDiagnostic } from '../core/diagnostic';
import { ShaderStore } from '../core/shader-store';
import { TextureAssets } from '../core/texture-assets';
import type { GlContext } from './gl-context';
import { GlContextRegistry } from './gl-context-registry';
import { RendererHandle } from './renderer-handle';
import { type ChannelSource, type EnginePass, ShaderEngine } from './shader-engine';

const EMPTY_CHANNELS: readonly (ChannelSource | null)[] = [null, null, null, null];

/** Also used by `McpBridge` to know how long to wait before reading back diagnostics. */
export const RECOMPILE_DEBOUNCE_MS = 400;

@Component({
  selector: 'app-shader-canvas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatDividerModule, MatIconModule, MatMenuModule],
  host: {
    '[class.detached]': 'detached()',
    '[class.full-size]': '!detached()',
    '[style.left.px]': 'detached() ? position().x : null',
    '[style.top.px]': 'detached() ? position().y : null',
  },
  template: `
    @if (detached()) {
      <div class="window-bar" (pointerdown)="startMove($event)" (dblclick)="showFullSize()">
        <mat-icon aria-hidden="true">blur_on</mat-icon>
        <span>Shader preview</span>
        <button
          type="button"
          class="window-action"
          aria-label="Display shader full size"
          title="Display full size"
          (pointerdown)="$event.stopPropagation()"
          (click)="showFullSize()"
        >
          <mat-icon>open_in_full</mat-icon>
        </button>
      </div>
    }
    <canvas
      #canvas
      class="shader-canvas"
      aria-hidden="true"
      [matContextMenuTriggerFor]="viewMenu"
    ></canvas>

    <mat-menu #viewMenu="matMenu">
      <button mat-menu-item type="button" (click)="toggleWindowMode()">
        <mat-icon>{{ detached() ? 'open_in_full' : 'open_in_new' }}</mat-icon>
        <span>{{ detached() ? 'Display full size' : 'Detach preview' }}</span>
      </button>
      @if (detached()) {
        <button mat-menu-item type="button" (click)="resetWindow()">
          <mat-icon>aspect_ratio</mat-icon>
          <span>Reset window</span>
        </button>
      }
      <mat-divider />
      <button mat-menu-item type="button" (click)="savePng()">
        <mat-icon>photo_camera</mat-icon>
        <span>Save PNG</span>
        <span class="hint">S</span>
      </button>
      <button mat-menu-item type="button" (click)="togglePause()">
        <mat-icon>{{ preferences.value().paused ? 'play_arrow' : 'pause' }}</mat-icon>
        <span>{{ preferences.value().paused ? 'Resume' : 'Pause' }}</span>
        <span class="hint">Space</span>
      </button>
      <button
        mat-menu-item
        type="button"
        [disabled]="!store.record()"
        (click)="store.resetParams()"
      >
        <mat-icon>restart_alt</mat-icon>
        <span>Reset parameters</span>
      </button>

      <mat-divider />

      <button mat-menu-item type="button" (click)="toggle('guiVisible')">
        <mat-icon>{{ preferences.value().guiVisible ? 'visibility_off' : 'tune' }}</mat-icon>
        <span>{{ preferences.value().guiVisible ? 'Hide controls' : 'Show controls' }}</span>
        <span class="hint">H</span>
      </button>
      <button mat-menu-item type="button" (click)="toggle('editorOpen')">
        <mat-icon>code</mat-icon>
        <span>{{ preferences.value().editorOpen ? 'Hide editor' : 'Show editor' }}</span>
      </button>

      <mat-divider />

      <button mat-menu-item type="button" [matMenuTriggerFor]="themeMenu">
        <mat-icon>{{ themeIcon() }}</mat-icon>
        <span>Theme</span>
      </button>

      @if (desktop.available) {
        <mat-divider />
        <button mat-menu-item type="button" (click)="desktop.toggleFullscreen()">
          <mat-icon>{{ desktop.fullscreen() ? 'fullscreen_exit' : 'fullscreen' }}</mat-icon>
          <span>{{ desktop.fullscreen() ? 'Exit fullscreen' : 'Enter fullscreen' }}</span>
          <span class="hint">F11</span>
        </button>
      }
    </mat-menu>

    <mat-menu #themeMenu="matMenu">
      @for (option of colorSchemeOptions; track option.value) {
        <button
          mat-menu-item
          type="button"
          [attr.aria-checked]="preferences.value().colorScheme === option.value"
          (click)="setColorScheme(option.value)"
        >
          <mat-icon>{{ option.icon }}</mat-icon>
          <span>{{ option.label }}</span>
          @if (preferences.value().colorScheme === option.value) {
            <mat-icon class="hint" aria-hidden="true">check</mat-icon>
          }
        </button>
      }
    </mat-menu>
  `,
  styles: `
    :host {
      position: fixed;
      inset: 0;
      z-index: 0;
      display: block;
      background: #0a0c10;
    }

    :host(.detached) {
      inset: auto;
      z-index: 4;
      width: min(720px, calc(100vw - 48px));
      height: min(480px, calc(100vh - 48px));
      min-width: 320px;
      min-height: 240px;
      max-width: calc(100vw - 16px);
      max-height: calc(100vh - 16px);
      overflow: hidden;
      resize: both;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: var(--mat-sys-corner-medium, 8px);
      box-shadow: var(--mat-sys-level5);
    }

    .window-bar {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 8px;
      height: 30px;
      padding: 0 2px 0 8px;
      background: color-mix(in srgb, var(--mat-sys-surface-container-high) 92%, transparent);
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-label-large);
      cursor: move;
      user-select: none;
      touch-action: none;
    }

    .window-bar > mat-icon {
      color: var(--mat-sys-primary);
      width: 16px;
      height: 16px;
      font-size: 16px;
    }

    .window-bar span {
      flex: 1;
    }

    .window-action {
      display: grid;
      place-items: center;
      width: 26px;
      height: 26px;
      padding: 0;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: inherit;
      cursor: pointer;
    }

    .window-action:hover {
      background: color-mix(in srgb, var(--mat-sys-on-surface) 10%, transparent);
    }

    .window-action mat-icon {
      width: 16px;
      height: 16px;
      font-size: 16px;
    }

    .shader-canvas {
      display: block;
      width: 100%;
      height: 100%;
      touch-action: none;
    }

    :host(.detached) .shader-canvas {
      height: calc(100% - 30px);
    }

    .hint {
      margin-left: auto;
      padding-left: 24px;
    }
  `,
})
export class ShaderCanvas {
  protected readonly store = inject(ShaderStore);
  protected readonly preferences = inject(Preferences);
  protected readonly desktop = inject(DesktopPlatform);
  private readonly handle = inject(RendererHandle);
  private readonly contexts = inject(GlContextRegistry);
  private readonly destroyRef = inject(DestroyRef);
  private readonly textures = inject(TextureAssets);

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly engine = signal<ShaderEngine | null>(null);
  protected readonly detached = signal(false);
  protected readonly position = signal({ x: 48, y: 96 });
  private move: { pointerId: number; dx: number; dy: number } | null = null;

  protected readonly colorSchemeOptions = COLOR_SCHEME_OPTIONS;
  protected readonly themeIcon = computed(() =>
    colorSchemeIcon(this.preferences.value().colorScheme),
  );

  /**
   * The project, composed into the passes the engine wants.
   *
   * Composition is what turns "which passes does this edit affect?" from a
   * question somebody has to answer into one nobody has to ask: a pass that an
   * edit did not touch composes to the same string it did last time, and the
   * engine skips it. Editing Buffer C recompiles Buffer C. Editing Common — or a
   * file two passes include — recompiles exactly the passes that use it.
   */
  private readonly passes = computed<readonly EnginePass[] | null>(() => {
    const project = this.store.project();
    if (!project) return null;

    return this.store.renderOrder().map((pass): EnginePass => {
      const { source, spans } = composePass(project, pass);
      return {
        id: pass.id,
        kind: pass.kind === 'image' ? 'image' : 'buffer',
        fragment: source,
        spans,
        channels: pass.channels,
        resolution: pass.resolution,
        filter: pass.filter,
        wrap: pass.wrap,
      };
    });
  });

  /** The `#include` failures, which are ours to report — the driver never sees them. */
  private readonly compositionErrors = computed<readonly CompileDiagnostic[]>(() => {
    const project = this.store.project();
    if (!project) return [];

    return this.store.renderOrder().flatMap((pass) =>
      composePass(project, pass).errors.map(
        (error): CompileDiagnostic => ({
          severity: 'error',
          line: error.line,
          message: error.message,
          source: 'fragment',
          docId: error.docId,
        }),
      ),
    );
  });

  private readonly debouncedPasses = signal<readonly EnginePass[] | null>(null);
  private readonly channelSources = signal<readonly (ChannelSource | null)[]>(EMPTY_CHANNELS);

  /** The last `recompileRequest` acted on, so a new one can be told from a redraw. */
  private lastRecompile = 0;

  constructor() {
    afterNextRender(() => {
      void this.boot();
    });

    // Debounced: a compile is expensive and a keystroke is not an edit. Every
    // pass whose composed source is unchanged when the dust settles is skipped
    // by the engine anyway, so the cost of a burst of typing is one recompile of
    // the one pass being typed into.
    effect((onCleanup) => {
      const passes = this.passes();
      if (!passes) {
        this.debouncedPasses.set(null);
        return;
      }

      this.store.compiling.set(new Set(passes.map((pass) => pass.id)));

      const timer = setTimeout(() => this.debouncedPasses.set(passes), RECOMPILE_DEBOUNCE_MS);
      onCleanup(() => clearTimeout(timer));
    });

    effect(() => {
      const engine = this.engine();
      const passes = this.debouncedPasses();
      const controls = this.store.controls();

      // Ctrl+Enter. Tracked, so asking for a recompile of a source nobody touched
      // still runs one — which is the entire point of asking.
      const requested = this.store.recompileRequest();
      const force = requested !== this.lastRecompile;
      this.lastRecompile = requested;

      if (!engine || !passes) return;

      untracked(() => {
        const draft = this.store.draft();
        const diagnostics = engine.setPasses(
          {
            vertex: this.store.vertex(),
            controls,
            params: this.store.params(),
            render: draft?.render ?? {
              bloom: { enabled: false, strength: 0, radius: 0, threshold: 1 },
            },
            passes,
            textures: this.channelSources(),
          },
          force,
        );

        this.store.setCompileDiagnostics([...this.compositionErrors(), ...diagnostics]);
        this.store.compiling.set(new Set());
      });
    });

    effect(() => {
      const engine = this.engine();
      const params = this.store.params();
      engine?.setParams(params);
    });

    // Resolving a channel to a URL is async (an HTTP fetch, or an IPC round
    // trip on desktop), so it goes through its own signal rather than
    // blocking the (synchronous) compile effect above.
    effect((onCleanup) => {
      const record = this.store.record();
      const channels = this.store.channels();
      if (!record) {
        this.channelSources.set(EMPTY_CHANNELS);
        return;
      }

      let cancelled = false;
      onCleanup(() => {
        cancelled = true;
      });

      void Promise.all(
        channels.map((channel, index) =>
          this.textures.resolve(record.id, index, channel, record.updatedAt),
        ),
      ).then((resolved) => {
        if (!cancelled) this.channelSources.set(resolved);
      });
    });

    effect(() => {
      const engine = this.engine();
      const channels = this.channelSources();
      engine?.setChannels(channels);
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

  protected toggleWindowMode(): void {
    if (this.detached()) this.showFullSize();
    else this.detach();
  }

  protected detach(): void {
    this.detached.set(true);
  }

  protected showFullSize(): void {
    this.detached.set(false);
    this.clearWindowSize();
  }

  protected resetWindow(): void {
    this.position.set({ x: 48, y: 96 });
    this.clearWindowSize();
  }

  private clearWindowSize(): void {
    const host = this.canvasRef().nativeElement.parentElement as HTMLElement | null;
    if (host) {
      host.style.width = '';
      host.style.height = '';
    }
  }

  protected startMove(event: PointerEvent): void {
    if (event.button !== 0) return;
    const host = (event.currentTarget as HTMLElement).parentElement as HTMLElement;
    const rect = host.getBoundingClientRect();
    this.move = {
      pointerId: event.pointerId,
      dx: event.clientX - rect.left,
      dy: event.clientY - rect.top,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      if (!this.move || next.pointerId !== this.move.pointerId) return;
      const x = Math.max(
        8,
        Math.min(next.clientX - this.move.dx, window.innerWidth - host.offsetWidth - 8),
      );
      const y = Math.max(
        8,
        Math.min(next.clientY - this.move.dy, window.innerHeight - host.offsetHeight - 8),
      );
      this.position.set({ x, y });
    };
    const end = (next: PointerEvent) => {
      if (!this.move || next.pointerId !== this.move.pointerId) return;
      this.move = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  protected toggle(key: 'editorOpen' | 'guiVisible'): void {
    this.preferences.patch({
      [key]: !this.preferences.value()[key],
    } as Partial<WorkspacePreferences>);
  }

  protected togglePause(): void {
    this.preferences.patch({ paused: !this.preferences.value().paused });
  }

  protected setColorScheme(colorScheme: ColorScheme): void {
    this.preferences.patch({ colorScheme });
  }

  protected async savePng(): Promise<void> {
    const name = this.store.record()?.id ?? 'shader';
    const saved = await this.handle.screenshot(name);
    if (!saved) {
      this.store.notice.set({ text: 'Nothing to capture yet', error: true });
    }
  }

  private async boot(): Promise<void> {
    const canvas = this.canvasRef().nativeElement;

    let engine: ShaderEngine;
    let context: GlContext;
    try {
      context = await this.contexts.create(canvas);
      engine = await ShaderEngine.create(context);
    } catch (error) {
      this.store.notice.set({
        text: `WebGL is unavailable, so the preview is disabled: ${String(error)}`,
        error: true,
      });
      return;
    }

    engine.onFps = (fps) => this.handle.fps.set(fps);

    // A lost context is recoverable and usually brief (a driver reset, a GPU
    // switch), so say so rather than reporting a failure: the shader, the
    // parameters and the clock are all still here, waiting to be replayed.
    engine.onContextLost = () =>
      this.store.notice.set({
        text: 'The GPU context was lost. Restoring the preview…',
        error: false,
      });
    engine.onContextRestored = () =>
      this.store.notice.set({ text: 'The GPU context was restored.', error: false });

    this.engine.set(engine);
    this.handle.register(context.id, engine);

    const observer = new ResizeObserver(() => engine.resize());
    observer.observe(canvas);

    this.destroyRef.onDestroy(() => {
      observer.disconnect();
      this.handle.unregister(context.id);
      // Disposes this context and nothing else: any other preview keeps running.
      this.contexts.destroy(context.id);
    });
  }
}
