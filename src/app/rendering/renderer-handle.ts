import { Injectable, computed, inject, signal } from '@angular/core';
import { DesktopPlatform } from '../desktop/desktop-platform';

import type { ThumbnailUpload } from '../api/shader-api';
import type { ShaderEngine } from './shader-engine';
import { encodeThumbnail } from './thumbnail';

/**
 * A handle on the live renderers.
 *
 * `ShaderCanvas` owns each engine's lifecycle; everything else (the toolbar's
 * screenshot button, the GUI's FPS readout) reaches one through here rather
 * than through a component reference, so no one has to know where the canvas
 * lives in the tree.
 *
 * There can be more than one engine now — a detached preview, an output window
 * — so they are held by context id. `engine` is the *active* one: the surface
 * the toolbar and the GUI act on, and the only thing the rest of the app has
 * ever needed. Consumers that predate multiple contexts keep working unchanged.
 */
@Injectable({ providedIn: 'root' })
export class RendererHandle {
  private readonly desktop = inject(DesktopPlatform);

  private readonly engines = signal<ReadonlyMap<string, ShaderEngine>>(new Map());
  private readonly activeId = signal<string | null>(null);

  /** The engine the app's global actions apply to. Null until a context exists. */
  readonly engine = computed(() => {
    const id = this.activeId();
    return id === null ? null : (this.engines().get(id) ?? null);
  });

  /** FPS of the active engine. */
  readonly fps = signal(0);

  readonly contextIds = computed(() => [...this.engines().keys()]);

  /** The engine on a given context, or null. */
  for(contextId: string): ShaderEngine | null {
    return this.engines().get(contextId) ?? null;
  }

  /** The first engine registered becomes the active one; later ones only join the map. */
  register(contextId: string, engine: ShaderEngine): void {
    this.engines.update((engines) => new Map(engines).set(contextId, engine));
    if (this.activeId() === null) this.activeId.set(contextId);
  }

  unregister(contextId: string): void {
    this.engines.update((engines) => {
      const next = new Map(engines);
      next.delete(contextId);
      return next;
    });

    // Losing the active engine hands the role to whichever is still rendering,
    // rather than leaving the toolbar pointing at nothing while a preview lives.
    if (this.activeId() === contextId) {
      const [first] = this.engines().keys();
      this.activeId.set(first ?? null);
      this.fps.set(0);
    }
  }

  setActive(contextId: string): void {
    if (this.engines().has(contextId)) this.activeId.set(contextId);
  }

  /** Save the current frame as a PNG. No-op if there is nothing rendering. */
  async screenshot(filename: string): Promise<boolean> {
    const engine = this.engine();
    if (!engine) return false;

    const blob = await engine.screenshot();
    if (!blob) return false;

    if (this.desktop.available) {
      return this.desktop.savePng(
        `${filename}-${Date.now()}.png`,
        new Uint8Array(await blob.arrayBuffer()),
      );
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filename}-${Date.now()}.png`;
    link.click();
    URL.revokeObjectURL(url);
    return true;
  }

  /**
   * The current frame, cropped and encoded as a library preview.
   *
   * `null` whenever there is nothing to photograph — no context yet, a shader
   * that failed to compile — which is a normal outcome, not an error: a save
   * simply keeps the preview it already had.
   */
  async captureThumbnail(): Promise<ThumbnailUpload | null> {
    const engine = this.engine();
    if (!engine) return null;

    const frame = await engine.screenshot();
    return frame ? encodeThumbnail(frame) : null;
  }
}
