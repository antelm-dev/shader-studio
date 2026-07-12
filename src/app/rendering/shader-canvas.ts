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

import { Preferences, type WorkspacePreferences } from '../core/preferences';
import { ShaderStore } from '../core/shader-store';
import { RendererHandle } from './renderer-handle';
import { ShaderEngine } from './shader-engine';

const RECOMPILE_DEBOUNCE_MS = 400;

@Component({
  selector: 'app-shader-canvas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatDividerModule, MatIconModule, MatMenuModule],
  template: `
    <canvas
      #canvas
      class="shader-canvas"
      aria-hidden="true"
      [matContextMenuTriggerFor]="viewMenu"
    ></canvas>

    <mat-menu #viewMenu="matMenu">
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
      <button mat-menu-item type="button" [disabled]="!store.record()" (click)="store.resetParams()">
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

      <button mat-menu-item type="button" (click)="toggleTheme()">
        <mat-icon>{{ darkMode() ? 'light_mode' : 'dark_mode' }}</mat-icon>
        <span>{{ darkMode() ? 'Light theme' : 'Dark theme' }}</span>
      </button>
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

    .shader-canvas {
      display: block;
      width: 100%;
      height: 100%;
      touch-action: none;
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
  private readonly handle = inject(RendererHandle);
  private readonly destroyRef = inject(DestroyRef);

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly engine = signal<ShaderEngine | null>(null);

  protected readonly darkMode = computed(() => this.preferences.value().colorScheme === 'dark');

  private readonly source = computed(() => {
    const draft = this.store.draft();
    return draft ? { fragment: draft.fragment, vertex: draft.vertex } : null;
  });

  private readonly debouncedSource = signal<{ fragment: string; vertex: string } | null>(null);

  constructor() {
    afterNextRender(() => {
      void this.boot();
    });

    effect((onCleanup) => {
      const source = this.source();
      if (!source) {
        this.debouncedSource.set(null);
        return;
      }
      const timer = setTimeout(() => this.debouncedSource.set(source), RECOMPILE_DEBOUNCE_MS);
      onCleanup(() => clearTimeout(timer));
    });

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

  protected toggle(key: 'editorOpen' | 'guiVisible'): void {
    this.preferences.patch({ [key]: !this.preferences.value()[key] } as Partial<WorkspacePreferences>);
  }

  protected togglePause(): void {
    this.preferences.patch({ paused: !this.preferences.value().paused });
  }

  protected toggleTheme(): void {
    this.preferences.patch({ colorScheme: this.darkMode() ? 'light' : 'dark' });
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
    try {
      engine = await ShaderEngine.create(canvas);
    } catch (error) {
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
