import { Injectable, inject, signal } from '@angular/core';
import { DesktopPlatform } from '../core/desktop-platform';

import type { ShaderEngine } from './shader-engine';

/**
 * A handle on the live renderer.
 *
 * `ShaderCanvas` owns the engine's lifecycle; everything else (the toolbar's
 * screenshot button, the GUI's FPS readout) reaches it through here rather than
 * through a component reference, so no one has to know where the canvas lives
 * in the tree. Null until the browser has actually created a context.
 */
@Injectable({ providedIn: 'root' })
export class RendererHandle {
  private readonly desktop = inject(DesktopPlatform);
  readonly engine = signal<ShaderEngine | null>(null);
  readonly fps = signal(0);

  /** Save the current frame as a PNG. No-op if there is nothing rendering. */
  async screenshot(filename: string): Promise<boolean> {
    const engine = this.engine();
    if (!engine) return false;

    const blob = await engine.screenshot();
    if (!blob) return false;

    if (this.desktop.available) {
      return this.desktop.savePng(`${filename}-${Date.now()}.png`, new Uint8Array(await blob.arrayBuffer()));
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filename}-${Date.now()}.png`;
    link.click();
    URL.revokeObjectURL(url);
    return true;
  }
}
