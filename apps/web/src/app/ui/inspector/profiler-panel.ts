import {
  Component,
  DestroyRef,
  effect,
  inject,
  OnDestroy,
  signal,
  type OnInit,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { interval } from 'rxjs';

import type { PassResolution } from '@shader-studio/shared';
import { Preferences } from '../../prefs/preferences';
import { RendererHandle } from '../../rendering/renderer-handle';
import type { ProfilerSnapshot } from '../../rendering/performance-profiler';
import { ShaderStore } from '../../workspace/shader-store';
import { I18n } from '../../i18n/i18n';
import { TranslatePipe } from '../../i18n/translate.pipe';
import {
  TARGET_FRAME_MS,
  formatBytes,
  formatFrameShare,
  formatMilliseconds,
  recommendLowerScale,
} from './profiler-recommendation';

@Component({
  selector: 'app-profiler-panel',
  imports: [MatButtonModule, TranslatePipe],
  template: `
    <section class="profiler">
      <p class="status" role="status" aria-live="polite">{{ statusText() }}</p>
      @if (snapshot(); as data) {
        <header class="section">
          <h3>{{ 'profiler.overview' | translate }}</h3>
          <p class="budget">{{ 'profiler.budget' | translate }}: {{ targetFrameMs }} ms (60 FPS)</p>
          @switch (data.gpuSupport) {
            @case ('warming') {
              <p class="state">{{ 'profiler.warming' | translate }}</p>
            }
            @case ('unavailable') {
              <p class="state">{{ 'profiler.gpuUnavailable' | translate }}</p>
            }
            @case ('disjoint') {
              <p class="state">{{ 'profiler.gpuDisjoint' | translate }}</p>
            }
          }
        </header>

        <dl class="metrics">
          <div>
            <dt>{{ 'profiler.cpuSubmission' | translate }}</dt>
            <dd>
              {{ formatMs(data.cpuSubmission.medianMs) }} /
              {{ formatMs(data.cpuSubmission.p95Ms) }}
            </dd>
          </div>
          <div>
            <dt>{{ 'profiler.gpuTotal' | translate }}</dt>
            <dd>
              {{ formatMs(data.totalGpu.medianMs) }} /
              {{ formatMs(data.totalGpu.p95Ms) }}
            </dd>
          </div>
          <div>
            <dt>{{ 'profiler.samples' | translate }}</dt>
            <dd>{{ data.sampleCount }}</dd>
          </div>
          <div>
            <dt>{{ 'profiler.sampleAge' | translate }}</dt>
            <dd>{{ formatMs(data.lastSampleAgeMs) }}</dd>
          </div>
        </dl>

        <section class="section">
          <h3>{{ 'profiler.passes' | translate }}</h3>
          @if (data.passes.length === 0) {
            <p class="state">{{ 'profiler.noPasses' | translate }}</p>
          } @else {
            <table class="pass-table">
              <thead>
                <tr>
                  <th scope="col">{{ 'profiler.pass' | translate }}</th>
                  <th scope="col">{{ 'profiler.gpuMedian' | translate }}</th>
                  <th scope="col">{{ 'profiler.frameShare' | translate }}</th>
                  <th scope="col">{{ 'profiler.resolution' | translate }}</th>
                  <th scope="col">{{ 'profiler.targetMemory' | translate }}</th>
                </tr>
              </thead>
              <tbody>
                @for (pass of data.passes; track pass.id) {
                  <tr>
                    <td>{{ pass.label }}</td>
                    <td>{{ formatMs(pass.gpu.medianMs) }}</td>
                    <td>{{ formatShare(pass.gpu.medianMs, data.totalGpu.medianMs) }}</td>
                    <td>
                      @if (pass.width !== null && pass.height !== null) {
                        {{ pass.width }}×{{ pass.height }}
                      } @else {
                        —
                      }
                    </td>
                    <td>{{ formatBytes(pass.targetBytes) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          }
        </section>

        <section class="section">
          <h3>{{ 'profiler.memory' | translate }}</h3>
          <p class="note">{{ 'profiler.memoryEstimate' | translate }}</p>
          <dl class="metrics">
            <div>
              <dt>{{ 'profiler.renderTargets' | translate }}</dt>
              <dd>{{ formatBytes(data.renderTargetBytes) }}</dd>
            </div>
            <div>
              <dt>{{ 'profiler.textures' | translate }}</dt>
              <dd>{{ formatBytes(data.textureBytes) }}</dd>
            </div>
          </dl>
        </section>

        @if (data.compiles.length > 0) {
          <section class="section">
            <h3>{{ 'profiler.compiles' | translate }}</h3>
            <ul class="compile-list">
              @for (entry of data.compiles; track entry.passId) {
                <li>
                  <span>{{ entry.passId }}</span>
                  <span>{{ formatMs(entry.durationMs) }}</span>
                  <span>{{
                    (entry.success ? 'profiler.compileOk' : 'profiler.compileFailed') | translate
                  }}</span>
                </li>
              }
            </ul>
          </section>
        }

        @if (suggestion(); as scale) {
          <section class="section suggestion">
            <p>{{ 'profiler.suggestBody' | translate: { scale: scale.toFixed(2) } }}</p>
            <button matButton="filled" type="button" (click)="applySuggestion(scale)">
              {{ 'profiler.suggestAction' | translate }}
            </button>
          </section>
        }
      } @else {
        <p class="state">{{ 'profiler.empty' | translate }}</p>
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
      max-width: 100%;
      padding: 0 12px 12px;
      overflow-x: clip;
    }

    .profiler {
      display: flex;
      flex-direction: column;
      min-width: 0;
      max-width: 100%;
      gap: 16px;
      font: var(--mat-sys-body-medium);
    }

    .section h3 {
      margin: 0 0 8px;
      font: var(--mat-sys-title-small);
    }

    .budget,
    .note,
    .state {
      margin: 0;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px 12px;
      margin: 0;
    }

    .metrics div {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .metrics dt {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-small);
    }

    .metrics dd {
      margin: 0;
    }

    .status {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    .pass-table {
      width: 100%;
      table-layout: fixed;
      border-collapse: collapse;
      font: var(--mat-sys-body-small);
    }

    .pass-table th,
    .pass-table td {
      padding: 4px 6px;
      overflow-wrap: anywhere;
      text-align: left;
      vertical-align: top;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }

    .pass-table th:first-child,
    .pass-table td:first-child {
      width: 24%;
    }

    .compile-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
      font: var(--mat-sys-body-small);
    }

    .compile-list li {
      display: grid;
      grid-template-columns: 1fr auto auto;
      gap: 8px;
    }

    .suggestion {
      padding: 12px;
      border-radius: 8px;
      background: var(--mat-sys-surface-container);
    }
  `,
})
export class ProfilerPanel implements OnInit, OnDestroy {
  protected readonly targetFrameMs = TARGET_FRAME_MS.toFixed(2);
  protected readonly formatMs = formatMilliseconds;
  protected readonly formatBytes = formatBytes;
  protected readonly formatShare = formatFrameShare;

  private readonly handle = inject(RendererHandle);
  private readonly preferences = inject(Preferences);
  private readonly store = inject(ShaderStore);
  private readonly i18n = inject(I18n);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly snapshot = signal<ProfilerSnapshot | null>(null);
  protected readonly suggestion = signal<number | null>(null);
  protected readonly statusText = signal('');

  private appliedSuggestion: number | null = null;
  private holdAppliedStatus = false;
  private lastSeenScale: number | null = null;

  constructor() {
    effect(() => {
      const active = this.preferences.value().inspectorTab === 'profiler';
      this.handle.setProfilingEnabled(active);
      if (!active) {
        this.snapshot.set(null);
        this.suggestion.set(null);
        this.appliedSuggestion = null;
        this.holdAppliedStatus = false;
        this.statusText.set('');
        this.lastSeenScale = null;
      }
    });

    effect(() => {
      if (this.preferences.value().inspectorTab !== 'profiler') return;

      // Track engine replacement and lifecycle generations so stale snapshots clear immediately.
      void this.handle.engine();
      void this.handle.profilerEpoch();

      const scale = this.preferences.value().resolutionScale;
      if (this.lastSeenScale !== null && this.lastSeenScale !== scale) {
        this.suggestion.set(null);
      }
      this.lastSeenScale = scale;

      this.refresh();
    });
  }

  ngOnInit(): void {
    interval(500)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.refresh());
    this.refresh();
  }

  ngOnDestroy(): void {
    this.handle.setProfilingEnabled(false);
  }

  protected applySuggestion(scale: number): void {
    if (this.appliedSuggestion === scale) return;
    this.preferences.patch({ resolutionScale: scale });
    this.appliedSuggestion = scale;
    this.suggestion.set(null);
    this.holdAppliedStatus = true;
    this.statusText.set(this.i18n.t('profiler.statusApplied', { scale: scale.toFixed(2) }));
    // Drop pre-application samples immediately; canvas also resets via setResolutionScale.
    this.handle.resetProfilerSamples();
  }

  private refresh(): void {
    if (this.preferences.value().inspectorTab !== 'profiler') return;

    const data = this.handle.profilerSnapshot();
    this.snapshot.set(data);
    if (!data) {
      this.suggestion.set(null);
      if (!this.holdAppliedStatus) this.statusText.set('');
      return;
    }

    // Hold the applied announcement until samples restart at the new scale.
    if (this.holdAppliedStatus) {
      this.suggestion.set(null);
      if (data.sampleCount === 0) return;
      this.holdAppliedStatus = false;
    }

    const resolutionByPass = new Map<string, PassResolution>(
      this.store.passes().map((pass) => [pass.id, pass.resolution]),
    );

    const proposed = recommendLowerScale({
      gpuSupport: data.gpuSupport,
      totalGpuP95Ms: data.totalGpu.p95Ms,
      cpuSubmissionP95Ms: data.cpuSubmission.p95Ms,
      sampleCount: data.sampleCount,
      lastSampleAgeMs: data.lastSampleAgeMs,
      currentScale: this.preferences.value().resolutionScale,
      passes: data.passes.map((pass) => ({
        id: pass.id,
        gpuP95Ms: pass.gpu.p95Ms,
        fixedResolution: resolutionByPass.get(pass.id)?.mode === 'fixed',
      })),
    });

    if (proposed !== null && proposed === this.appliedSuggestion) {
      this.suggestion.set(null);
      this.statusText.set('');
      return;
    }

    this.suggestion.set(proposed);
    this.statusText.set(
      proposed === null
        ? ''
        : this.i18n.t('profiler.statusSuggestion', { scale: proposed.toFixed(2) }),
    );
  }
}
