import type { WebGLRenderer } from 'three';

import {
  RGBA16F_BYTES_PER_PIXEL,
  RENDER_TARGETS_PER_BUFFER,
  type BufferAllocation,
} from './pass-targets';
import type { TextureManager } from './engine/texture-manager';

/** Synthetic pass id for the final image draw when bloom is off. */
export const IMAGE_PASS_ID = '__image__';

/** Synthetic pass id for the composer path when bloom is on. */
export const POST_PASS_ID = '__post__';

/** Minimum resolved GPU samples before median/p95 are published. */
export const PROFILER_MIN_GPU_SAMPLES = 30;

/** Rolling window size for timing percentiles. */
export const PROFILER_WINDOW_SIZE = 120;

export type ProfilerGpuSupport = 'warming' | 'supported' | 'unavailable' | 'disjoint';

export interface ProfilerTiming {
  readonly medianMs: number | null;
  readonly p95Ms: number | null;
}

export interface ProfilerPassTiming {
  readonly id: string;
  readonly label: string;
  readonly gpu: ProfilerTiming;
  readonly width: number | null;
  readonly height: number | null;
  readonly targetBytes: number | null;
}

export interface ProfilerCompileRecord {
  readonly passId: string;
  readonly durationMs: number;
  readonly success: boolean;
}

export interface ProfilerTextureAllocation {
  readonly slot: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly bytes: number | null;
}

export interface ProfilerSnapshot {
  readonly enabled: boolean;
  readonly gpuSupport: ProfilerGpuSupport;
  readonly sampleCount: number;
  readonly lastSampleAgeMs: number | null;
  readonly cpuSubmission: ProfilerTiming;
  readonly totalGpu: ProfilerTiming;
  readonly passes: readonly ProfilerPassTiming[];
  readonly renderTargetBytes: number;
  readonly textureBytes: number | null;
  readonly textureEstimated: true;
  readonly textures: readonly ProfilerTextureAllocation[];
  readonly compiles: readonly ProfilerCompileRecord[];
}

interface GpuTimerExtension {
  readonly TIME_ELAPSED_EXT: number;
  readonly QUERY_RESULT_EXT: number;
  readonly QUERY_RESULT_AVAILABLE_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

interface PendingGpuSample {
  readonly query: WebGLQuery;
  readonly kind: 'total' | 'pass';
  readonly passId?: string;
}

interface PassSchedule {
  readonly passIds: readonly string[];
  readonly mode: 'total' | 'pass';
  readonly passId: string | null;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

function timingFrom(samples: readonly number[]): ProfilerTiming {
  if (samples.length < PROFILER_MIN_GPU_SAMPLES) {
    return { medianMs: null, p95Ms: null };
  }
  return { medianMs: median(samples), p95Ms: percentile(samples, 0.95) };
}

function passLabel(id: string): string {
  if (id === IMAGE_PASS_ID) return 'Image';
  if (id === POST_PASS_ID) return 'Post-processing';
  return id;
}

class RollingSamples {
  private readonly values: number[] = [];

  push(value: number): void {
    this.values.push(value);
    if (this.values.length > PROFILER_WINDOW_SIZE) this.values.shift();
  }

  get length(): number {
    return this.values.length;
  }

  stats(): ProfilerTiming {
    return timingFrom(this.values);
  }

  clear(): void {
    this.values.length = 0;
  }
}

class GpuTimerAdapter {
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: GpuTimerExtension | null;
  private activeQuery: WebGLQuery | null = null;
  private readonly pending: PendingGpuSample[] = [];
  private disjoint = false;

  constructor(renderer: WebGLRenderer) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2') as GpuTimerExtension | null;
  }

  get supported(): boolean {
    return this.ext !== null;
  }

  private activeKind: 'total' | 'pass' = 'total';
  private activePassId: string | undefined;

  begin(kind: 'total' | 'pass', passId?: string): void {
    if (!this.ext || this.activeQuery || this.disjoint) return;

    const query = this.gl.createQuery();
    if (!query) return;

    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.activeQuery = query;
    this.activeKind = kind;
    this.activePassId = passId;
  }

  end(): void {
    if (!this.ext || !this.activeQuery) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push({
      query: this.activeQuery,
      kind: this.activeKind,
      passId: this.activePassId,
    });
    this.activeQuery = null;
    this.activePassId = undefined;
  }

  poll(): { totalMs: number | null; passMs: Map<string, number>; disjoint: boolean } {
    const passMs = new Map<string, number>();
    let totalMs: number | null = null;

    if (!this.ext) return { totalMs, passMs, disjoint: false };

    if (this.gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
      this.disjoint = true;
      this.discardPending();
      return { totalMs: null, passMs, disjoint: true };
    }

    const stillPending: PendingGpuSample[] = [];

    for (const sample of this.pending) {
      const available = this.gl.getQueryParameter(
        sample.query,
        this.ext.QUERY_RESULT_AVAILABLE_EXT,
      );
      if (!available) {
        stillPending.push(sample);
        continue;
      }

      const nanos = this.gl.getQueryParameter(sample.query, this.ext.QUERY_RESULT_EXT) as number;
      this.gl.deleteQuery(sample.query);
      const ms = nanos / 1_000_000;

      if (sample.kind === 'total') totalMs = ms;
      else if (sample.passId) passMs.set(sample.passId, ms);
    }

    this.pending.length = 0;
    this.pending.push(...stillPending);
    return { totalMs, passMs, disjoint: false };
  }

  clear(): void {
    for (const sample of this.pending) this.gl.deleteQuery(sample.query);
    this.pending.length = 0;
    this.activeQuery = null;
    this.disjoint = false;
  }

  private discardPending(): void {
    for (const sample of this.pending) this.gl.deleteQuery(sample.query);
    this.pending.length = 0;
    this.activeQuery = null;
  }
}

export class PerformanceProfiler {
  private enabled = false;
  private timer: GpuTimerAdapter | null = null;
  private gpuSupport: ProfilerGpuSupport = 'unavailable';
  private frameIndex = 0;
  private lastSampleAt: number | null = null;
  private resolvedGpuSamples = 0;

  private readonly cpuSamples = new RollingSamples();
  private readonly totalGpuSamples = new RollingSamples();
  private readonly passGpuSamples = new Map<string, RollingSamples>();
  private readonly compileByPass = new Map<string, ProfilerCompileRecord>();
  private passIds: readonly string[] = [];
  private currentSchedule: PassSchedule = { passIds: [], mode: 'total', passId: null };

  constructor(
    private readonly getRenderer: () => WebGLRenderer | null,
    private readonly getTextures: () => TextureManager,
  ) {}

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;

    this.enabled = enabled;
    if (!enabled) {
      this.clear();
      return;
    }

    const renderer = this.getRenderer();
    if (!renderer) {
      this.gpuSupport = 'unavailable';
      return;
    }

    this.timer = new GpuTimerAdapter(renderer);
    this.gpuSupport = this.timer.supported ? 'warming' : 'unavailable';
    this.frameIndex = 0;
    this.resolvedGpuSamples = 0;
    this.lastSampleAt = null;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  schedulePasses(
    bufferIds: readonly string[],
    hasImage: boolean,
    usesComposer: boolean,
  ): PassSchedule {
    const finals: string[] = [];
    if (hasImage) finals.push(usesComposer ? POST_PASS_ID : IMAGE_PASS_ID);
    this.passIds = [...bufferIds, ...finals];

    const cycle = 1 + this.passIds.length;
    const slot = this.frameIndex % cycle;
    if (slot === 0 || this.passIds.length === 0) {
      this.currentSchedule = { passIds: this.passIds, mode: 'total', passId: null };
    } else {
      const passId = this.passIds[slot - 1] ?? null;
      this.currentSchedule = { passIds: this.passIds, mode: 'pass', passId };
    }

    return this.currentSchedule;
  }

  isTotalFrame(): boolean {
    return this.currentSchedule.mode === 'total';
  }

  currentPassId(): string | null {
    return this.currentSchedule.passId;
  }

  beginGpu(): void {
    if (!this.enabled || !this.timer?.supported || this.gpuSupport === 'disjoint') return;

    if (this.currentSchedule.mode === 'total') this.timer.begin('total');
    else if (this.currentSchedule.passId) {
      this.timer.begin('pass', this.currentSchedule.passId);
    }
  }

  endGpu(): void {
    if (!this.enabled || !this.timer?.supported || this.gpuSupport === 'disjoint') return;
    this.timer.end();
  }

  endFrame(cpuSubmissionMs: number): void {
    if (!this.enabled) return;

    this.cpuSamples.push(cpuSubmissionMs);
    this.frameIndex++;

    const poll = this.timer?.poll();
    if (!poll) return;

    if (poll.disjoint) {
      this.gpuSupport = 'disjoint';
      this.totalGpuSamples.clear();
      for (const samples of this.passGpuSamples.values()) samples.clear();
      this.resolvedGpuSamples = 0;
      return;
    }

    if (poll.totalMs !== null) {
      this.totalGpuSamples.push(poll.totalMs);
      this.resolvedGpuSamples++;
      this.lastSampleAt = performance.now();
      if (this.gpuSupport === 'warming' && this.resolvedGpuSamples >= PROFILER_MIN_GPU_SAMPLES) {
        this.gpuSupport = 'supported';
      }
    }

    for (const [passId, ms] of poll.passMs) {
      const bucket = this.passGpuSamples.get(passId) ?? new RollingSamples();
      bucket.push(ms);
      this.passGpuSamples.set(passId, bucket);
      this.resolvedGpuSamples++;
      this.lastSampleAt = performance.now();
      if (this.gpuSupport === 'warming' && this.resolvedGpuSamples >= PROFILER_MIN_GPU_SAMPLES) {
        this.gpuSupport = 'supported';
      }
    }
  }

  recordCompile(passId: string, durationMs: number, success: boolean): void {
    this.compileByPass.set(passId, { passId, durationMs, success });
  }

  onContextLost(): void {
    this.clearTransient();
    if (this.enabled) this.gpuSupport = this.timer?.supported ? 'warming' : 'unavailable';
  }

  onCaptureStart(): void {
    this.setEnabled(false);
  }

  dispose(): void {
    this.clear();
    this.enabled = false;
  }

  snapshot(allocations: readonly BufferAllocation[]): ProfilerSnapshot {
    const textures = this.getTextures().textureAllocations();
    const renderTargetBytes = allocations.reduce((sum, entry) => sum + entry.bytes, 0);

    const passes: ProfilerPassTiming[] = this.passIds.map((id) => {
      const size = allocations.find((entry) => entry.id === id);
      const isSynthetic = id === IMAGE_PASS_ID || id === POST_PASS_ID;
      return {
        id,
        label: passLabel(id),
        gpu: (this.passGpuSamples.get(id) ?? new RollingSamples()).stats(),
        width: isSynthetic ? null : (size?.width ?? null),
        height: isSynthetic ? null : (size?.height ?? null),
        targetBytes: isSynthetic ? null : (size?.bytes ?? null),
      };
    });

    return {
      enabled: this.enabled,
      gpuSupport: this.enabled ? this.gpuSupport : 'unavailable',
      sampleCount: this.resolvedGpuSamples,
      lastSampleAgeMs:
        this.lastSampleAt === null ? null : Math.max(0, performance.now() - this.lastSampleAt),
      cpuSubmission: this.cpuSamples.stats(),
      totalGpu: this.totalGpuSamples.stats(),
      passes,
      renderTargetBytes,
      textureBytes: textures.totalBytes,
      textureEstimated: true,
      textures: textures.items,
      compiles: [...this.compileByPass.values()],
    };
  }

  private clear(): void {
    this.timer?.clear();
    this.timer = null;
    this.clearTransient();
    this.gpuSupport = 'unavailable';
  }

  private clearTransient(): void {
    this.cpuSamples.clear();
    this.totalGpuSamples.clear();
    this.passGpuSamples.clear();
    this.frameIndex = 0;
    this.resolvedGpuSamples = 0;
    this.lastSampleAt = null;
    this.passIds = [];
    this.currentSchedule = { passIds: [], mode: 'total', passId: null };
  }
}

export function bufferAllocationBytes(width: number, height: number): number {
  return width * height * RGBA16F_BYTES_PER_PIXEL * RENDER_TARGETS_PER_BUFFER;
}
