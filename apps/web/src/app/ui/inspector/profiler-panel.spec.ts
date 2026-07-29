import { describe, expect, it } from 'vitest';

import { PROFILER_MIN_GPU_SAMPLES } from '../../rendering/performance-profiler';
import {
  MIN_RESOLUTION_SCALE,
  TARGET_FRAME_MS,
  formatBytes,
  formatMilliseconds,
  recommendLowerScale,
  roundScaleDown,
} from './profiler-recommendation';

describe('formatMilliseconds', () => {
  it('uses an em dash for unavailable values', () => {
    expect(formatMilliseconds(null)).toBe('—');
  });

  it('formats finite values with two decimals', () => {
    expect(formatMilliseconds(12.345)).toBe('12.35 ms');
  });
});

describe('formatBytes', () => {
  it('formats kilobytes and megabytes consistently', () => {
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(2_097_152)).toBe('2.0 MB');
  });
});

describe('roundScaleDown', () => {
  it('rounds down to the 0.05 step', () => {
    expect(roundScaleDown(0.87)).toBe(0.85);
  });
});

describe('recommendLowerScale', () => {
  const base = {
    gpuSupport: 'supported' as const,
    totalGpuP95Ms: TARGET_FRAME_MS * 2,
    cpuSubmissionP95Ms: 1,
    sampleCount: PROFILER_MIN_GPU_SAMPLES,
    lastSampleAgeMs: 50,
    currentScale: 1,
    passes: [{ id: 'buf-a', gpuP95Ms: 2, fixedResolution: false }],
  };

  it('returns a lower clamped scale for sustained GPU-bound frames', () => {
    const scale = recommendLowerScale(base);
    expect(scale).not.toBeNull();
    expect(scale!).toBeLessThan(1);
    expect(scale!).toBeGreaterThanOrEqual(MIN_RESOLUTION_SCALE);
  });

  it('returns null when GPU timing is still warming', () => {
    expect(recommendLowerScale({ ...base, gpuSupport: 'warming' })).toBeNull();
  });

  it('returns null when the workload is already within budget', () => {
    expect(recommendLowerScale({ ...base, totalGpuP95Ms: TARGET_FRAME_MS })).toBeNull();
  });

  it('returns null when samples are stale', () => {
    expect(recommendLowerScale({ ...base, lastSampleAgeMs: 900 })).toBeNull();
  });

  it('returns null when rendering is CPU-bound', () => {
    expect(
      recommendLowerScale({ ...base, totalGpuP95Ms: 20, cpuSubmissionP95Ms: 20 }),
    ).toBeNull();
  });

  it('returns null when fixed-resolution cost dominates', () => {
    expect(
      recommendLowerScale({
        ...base,
        totalGpuP95Ms: 40,
        passes: [{ id: 'buf-a', gpuP95Ms: 38, fixedResolution: true }],
      }),
    ).toBeNull();
  });

  it('never suggests a scale below the minimum or above the current value', () => {
    const scale = recommendLowerScale({ ...base, currentScale: 0.3 });
    expect(scale === null || scale < 0.3).toBe(true);
    if (scale !== null) expect(scale).toBeGreaterThanOrEqual(MIN_RESOLUTION_SCALE);
  });
});
