import { Injectable, effect, inject, untracked } from '@angular/core';

import type { ShaderParams, ShaderRecord } from '@shader-studio/shared/model';
import { Preferences } from './preferences';
import { ShaderStore, type ShaderDraft } from './shader-store';

interface OutputSnapshot {
  kind: 'snapshot';
  record: ShaderRecord | null;
  draft: ShaderDraft | null;
  params: ShaderParams;
  paused: boolean;
  resolutionScale: number;
  autoRipples: boolean;
}

type OutputMessage = OutputSnapshot | { kind: 'ready' };

@Injectable({ providedIn: 'root' })
export class OutputSync {
  private readonly store = inject(ShaderStore);
  private readonly preferences = inject(Preferences);
  private channel: BroadcastChannel | null = null;

  startController(): void {
    if (typeof BroadcastChannel === 'undefined' || this.channel) return;
    this.channel = new BroadcastChannel('shader-studio.output');
    this.channel.onmessage = ({ data }: MessageEvent<OutputMessage>) => {
      if (data.kind === 'ready') this.publish();
    };
    effect(() => {
      this.store.record();
      this.store.draft();
      this.store.params();
      const { paused, resolutionScale, autoRipples } = this.preferences.value();
      untracked(() => this.publish({ paused, resolutionScale, autoRipples }));
    });
  }

  startOutput(): void {
    if (typeof BroadcastChannel === 'undefined' || this.channel) return;
    this.channel = new BroadcastChannel('shader-studio.output');
    this.channel.onmessage = ({ data }: MessageEvent<OutputMessage>) => {
      if (data.kind !== 'snapshot') return;
      this.store.record.set(data.record);
      this.store.draft.set(data.draft);
      this.store.params.set(data.params);
      this.preferences.patch({
        paused: data.paused,
        resolutionScale: data.resolutionScale,
        autoRipples: data.autoRipples,
      });
    };
    this.channel.postMessage({ kind: 'ready' } satisfies OutputMessage);
  }

  private publish(
    prefs = (() => {
      const { paused, resolutionScale, autoRipples } = this.preferences.value();
      return { paused, resolutionScale, autoRipples };
    })(),
  ): void {
    this.channel?.postMessage({
      kind: 'snapshot',
      record: this.store.record(),
      draft: this.store.draft(),
      params: this.store.params(),
      ...prefs,
    } satisfies OutputSnapshot);
  }
}
