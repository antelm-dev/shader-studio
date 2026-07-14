import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type GUI from 'lil-gui';
import type { Controller } from 'lil-gui';

import { Preferences } from '../../prefs/preferences';
import { ShaderStore } from '../../workspace/shader-store';
import { RendererHandle } from '../../rendering/renderer-handle';
import type { ShaderControl } from '@shader-studio/shared/model';

/**
 * The parameter panel, generated entirely from the shader's control schema.
 *
 * No shader ever writes GUI code: it declares `{ key, type, min, max, ... }`
 * and lil-gui gets built from that. Add a control to the config tab and its
 * knob appears here, bound to `u_<key>`, without a reload.
 *
 * lil-gui is imported dynamically — it injects a stylesheet on import, which
 * would throw during SSR.
 */

/** Controls with no folder of their own are grouped under this one. */
const DEFAULT_FOLDER = 'Parameters';

@Component({
  selector: 'app-gui-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div #host class="gui-host"></div>
    @if (store.controls().length === 0 && store.record()) {
      <p class="empty">This shader declares no controls. Add some in the Config tab.</p>
    }
  `,
  styles: `
    :host {
      display: block;
      padding: 0 12px;
    }

    .empty {
      margin: 8px 0 0;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }

    /*
     * Passing a container already turns off lil-gui's fixed positioning, so
     * this just makes it fill the rail. The class names are lil-gui 0.21's,
     * which prefixes every one of them with lil-.
     */
    .gui-host ::ng-deep .lil-gui.lil-root {
      --background-color: transparent;
      --width: 100%;

      max-height: none;
      width: 100%;
    }

    /* The panel already has a heading of its own. */
    .gui-host ::ng-deep .lil-gui.lil-root > .lil-title {
      display: none;
    }
  `,
})
export class GuiPanel {
  protected readonly store = inject(ShaderStore);
  private readonly preferences = inject(Preferences);
  private readonly renderer = inject(RendererHandle);
  private readonly destroyRef = inject(DestroyRef);

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');

  private readonly lib = signal<typeof GUI | null>(null);
  private gui: GUI | null = null;

  /**
   * The object lil-gui actually mutates. Kept in step with `store.params()` in
   * both directions: lil-gui writes here and we push into the store; the store
   * changes (a preset, a reset) and we write back here.
   */
  private proxy: Record<string, unknown> = {};

  /** Live readouts, which lil-gui polls via `.listen()`. */
  private readonly system = {
    fps: 0,
    resolutionScale: 1,
    paused: false,
    autoRipples: false,
    savePng: () => void this.savePng(),
    resetParams: () => this.store.resetParams(),
  };

  constructor() {
    afterNextRender(async () => {
      const module = await import('lil-gui');
      this.lib.set(module.default);
    });

    // Rebuild whenever the schema changes shape. Cheap enough (a handful of DOM
    // nodes) that diffing the controls would be more code than it is worth.
    effect(() => {
      const GuiClass = this.lib();
      const controls = this.store.controls();
      if (!GuiClass) return;

      untracked(() => this.rebuild(GuiClass, controls));
    });

    // Push store -> GUI. Only touches controllers whose value actually differs,
    // so dragging a slider is never fought by its own echo.
    effect(() => {
      const params = this.store.params();
      const gui = this.gui;
      if (!gui) return;

      let changed = false;
      for (const [key, value] of Object.entries(params)) {
        if (this.proxy[key] !== value) {
          this.proxy[key] = value;
          changed = true;
        }
      }
      if (changed) gui.controllersRecursive().forEach((controller) => controller.updateDisplay());
    });

    effect(() => {
      this.system.fps = this.renderer.fps();
    });

    effect(() => {
      const preferences = this.preferences.value();
      this.system.resolutionScale = preferences.resolutionScale;
      this.system.paused = preferences.paused;
      this.system.autoRipples = preferences.autoRipples;
      this.gui?.controllersRecursive().forEach((controller) => controller.updateDisplay());
    });

    this.destroyRef.onDestroy(() => this.gui?.destroy());
  }

  private rebuild(GuiClass: typeof GUI, controls: readonly ShaderControl[]): void {
    this.gui?.destroy();

    const gui = new GuiClass({
      container: this.host().nativeElement,
      title: 'Parameters',
      injectStyles: true,
    });
    this.gui = gui;

    this.proxy = { ...this.store.params() };

    const folders = new Map<string, GUI>();
    const folderFor = (name: string): GUI => {
      let folder = folders.get(name);
      if (!folder) {
        folder = gui.addFolder(name);
        folders.set(name, folder);
      }
      return folder;
    };

    for (const control of controls) {
      const parent = folderFor(control.folder ?? DEFAULT_FOLDER);
      const controller = this.addController(parent, control);

      controller.name(control.label ?? control.key).onChange((value: unknown) => {
        this.store.setParam(control.key, value as string | number | boolean);
      });
    }

    this.addRenderFolder(gui);
    this.addSystemFolder(gui);
  }

  /** The one place a control type is turned into a lil-gui widget. */
  private addController(parent: GUI, control: ShaderControl): Controller {
    switch (control.type) {
      case 'color':
        return parent.addColor(this.proxy, control.key);
      case 'select':
        return parent.add(this.proxy, control.key, control.options);
      case 'number':
        return parent.add(this.proxy, control.key, control.min, control.max, control.step);
      case 'boolean':
        return parent.add(this.proxy, control.key);
      default:
        // Unreachable while ShaderControl stays a closed union, but a schema
        // arriving from disk is only as trustworthy as the validator.
        throw new Error(`Unsupported control type: ${JSON.stringify(control)}`);
    }
  }

  /** Bloom belongs to the shader, so it is a draft edit rather than a param. */
  private addRenderFolder(gui: GUI): void {
    const render = this.store.draft()?.render;
    if (!render) return;

    const bloom = { ...render.bloom };
    const apply = (): void => this.store.setRender({ bloom: { ...bloom } });

    const folder = gui.addFolder('Bloom');
    folder.add(bloom, 'enabled').name('Enabled').onChange(apply);
    folder.add(bloom, 'strength', 0, 2).name('Strength').onChange(apply);
    folder.add(bloom, 'radius', 0, 1).name('Radius').onChange(apply);
    folder.add(bloom, 'threshold', 0, 1).name('Threshold').onChange(apply);
    folder.close();
  }

  private addSystemFolder(gui: GUI): void {
    const folder = gui.addFolder('System');

    folder
      .add(this.system, 'resolutionScale', 0.25, 2, 0.05)
      .name('Resolution Scale')
      .onChange((value: number) => this.preferences.patch({ resolutionScale: value }));

    folder
      .add(this.system, 'paused')
      .name('Pause (Space)')
      .onChange((value: boolean) => this.preferences.patch({ paused: value }));

    folder
      .add(this.system, 'autoRipples')
      .name('Auto Ripples')
      .onChange((value: boolean) => this.preferences.patch({ autoRipples: value }));

    folder.add(this.system, 'fps').name('FPS').listen().disable();
    // "Capture image", not "Save PNG": it does not save the shader, and every
    // command in this app that says Save now means one specific thing.
    folder.add(this.system, 'savePng').name('Capture Image (S)');
    folder.add(this.system, 'resetParams').name('Reset Parameters');
    folder.close();
  }

  private async savePng(): Promise<void> {
    const name = this.store.record()?.id ?? 'shader';
    const saved = await this.renderer.screenshot(name);
    if (!saved) {
      this.store.notice.set({ text: 'Nothing to capture yet', error: true });
    }
  }
}
