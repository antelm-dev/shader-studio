import { Injectable, computed, inject, signal } from '@angular/core';

import type { CaptureSettings } from '@shader-studio/shared/model';
import { DesktopPlatform } from '../core/desktop-platform';
import { ShaderStore } from '../core/shader-store';
import { I18n } from '../i18n/i18n';
import { outputIndices, planCapture, type CapturePlan } from '@shader-studio/shared/capture-plan';
import { CaptureCancelled, captureFrames } from './frame-capture';
import { RendererHandle } from './renderer-handle';
import { openSequence } from './sequence-writer';
import { openVideo } from './video-writer';

/**
 * Filming the shader: the one place that puts the plan, the engine and the
 * writer together.
 *
 * It is also the only place that knows a capture takes *time*. Everything under
 * it is either instantaneous (the plan) or per-frame (the engine, the writer);
 * this is the layer that has to be interruptible, has to say how far along it
 * is, and has to leave nothing behind when it is stopped halfway.
 */

export interface CaptureStatus {
  /** Frames drawn, of `total`. Drawing is the slow half; writing rides along with it. */
  readonly rendered: number;
  readonly total: number;
  readonly label: string;
}

@Injectable({ providedIn: 'root' })
export class ShaderCapture {
  private readonly renderer = inject(RendererHandle);
  private readonly desktop = inject(DesktopPlatform);
  private readonly store = inject(ShaderStore);
  private readonly i18n = inject(I18n);

  private readonly status = signal<CaptureStatus | null>(null);
  private controller: AbortController | null = null;

  /** The capture in flight, or `null`. Drives the progress dialog. */
  readonly progress = this.status.asReadonly();
  readonly running = computed(() => this.status() !== null);

  /** Stops the capture at the next frame boundary and throws away what it wrote. */
  cancel(): void {
    this.controller?.abort();
  }

  /**
   * Films the shader to a WebM, or to a folder/ZIP of numbered PNGs.
   *
   * Returns `false` only when there was nothing to film or the user backed out
   * of a picker — neither of which is worth a message. Anything that actually
   * went wrong is reported as a notice and still returns `false`.
   */
  async exportSequence(settings: CaptureSettings): Promise<boolean> {
    const engine = this.renderer.engine();
    if (!engine || this.running()) return false;

    const plan = planCapture(settings);
    return plan.settings.format === 'webm' ? this.exportVideo(plan) : this.exportPngSequence(plan);
  }

  private async exportVideo(plan: CapturePlan): Promise<boolean> {
    const stem = this.store.record()?.id ?? 'shader';

    let writer;
    try {
      writer = await openVideo(this.desktop, stem, plan);
    } catch (error) {
      this.store.notice.set({
        text: this.i18n.t('export.failed', {
          error: error instanceof Error ? error.message : String(error),
        }),
        error: true,
      });
      return false;
    }
    if (!writer) return false;

    const controller = new AbortController();
    this.controller = controller;
    this.status.set({ rendered: 0, total: plan.loopFrames, label: this.i18n.t('export.encoding') });

    try {
      await captureFrames(
        this.renderer.engine()!,
        plan,
        async (canvas, frame) => {
          for (const index of outputIndices(plan, frame.index)) {
            await writer.write(canvas, index);
          }
        },
        {
          signal: controller.signal,
          onProgress: (rendered, total) =>
            this.status.set({
              rendered,
              total,
              label: this.describe(plan, rendered, total),
            }),
        },
      );

      const where = await writer.finish();
      this.store.notice.set({ text: where, error: false });
      return true;
    } catch (error) {
      await writer.cancel().catch(() => undefined);
      if (!(error instanceof CaptureCancelled)) {
        this.store.notice.set({
          text: this.i18n.t('export.failed', {
            error: error instanceof Error ? error.message : String(error),
          }),
          error: true,
        });
      }
      return false;
    } finally {
      this.controller = null;
      this.status.set(null);
    }
  }

  private async exportPngSequence(plan: CapturePlan): Promise<boolean> {
    const stem = this.store.record()?.id ?? 'shader';

    const writer = await openSequence(this.desktop, stem, plan);
    if (!writer) return false;

    const controller = new AbortController();
    this.controller = controller;
    this.status.set({
      rendered: 0,
      total: plan.loopFrames,
      label: this.i18n.t('export.rendering'),
    });

    try {
      await captureFrames(
        this.renderer.engine()!,
        plan,
        async (canvas, frame) => {
          const png = await toPng(canvas);
          for (const index of outputIndices(plan, frame.index)) {
            await writer.write(index, png);
          }
        },
        {
          signal: controller.signal,
          onProgress: (rendered, total) =>
            this.status.set({
              rendered,
              total,
              label: this.describe(plan, rendered, total),
            }),
        },
      );

      const where = await writer.finish();
      this.store.notice.set({ text: where, error: false });
      return true;
    } catch (error) {
      await writer.cancel().catch(() => undefined);
      if (!(error instanceof CaptureCancelled)) {
        this.store.notice.set({
          text: this.i18n.t('export.failed', {
            error: error instanceof Error ? error.message : String(error),
          }),
          error: true,
        });
      }
      return false;
    } finally {
      this.controller = null;
      this.status.set(null);
    }
  }

  private describe(plan: CapturePlan, rendered: number, total: number): string {
    const drawn = rendered * plan.settings.subframes;
    return plan.settings.subframes > 1
      ? this.i18n.t('export.frameProgressDraws', {
          rendered,
          total,
          drawn,
          draws: plan.draws,
        })
      : this.i18n.t('export.frameProgress', { rendered, total });
  }
}

function toPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('The browser would not encode the frame as a PNG.'));
    }, 'image/png');
  });
}
