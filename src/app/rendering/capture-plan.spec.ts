import { describe, expect, it } from 'vitest';

import { DEFAULT_CAPTURE } from '../../shared/model';
import {
  MAX_CAPTURE_SIZE,
  ffmpegCommand,
  frameName,
  normalizeCapture,
  planCapture,
  sequencePadding,
} from './capture-plan';

/**
 * The plan is the whole determinism argument, so this is where it is pinned.
 *
 * None of it needs a GPU: a frame is a time, a time is arithmetic on an index,
 * and if that arithmetic is right the pixels follow. What is being defended
 * here is that the same settings always give the same timetable, that a loop
 * does not stutter at the seam, and that a loop is not paid for twice.
 */

describe('normalizeCapture', () => {
  it('fills in the defaults for anything left out', () => {
    expect(normalizeCapture()).toEqual(DEFAULT_CAPTURE);
    expect(normalizeCapture({ fps: 30 })).toEqual({ ...DEFAULT_CAPTURE, fps: 30 });
  });

  it('keeps webm as the default format and only accepts png as the other', () => {
    expect(normalizeCapture().format).toBe('webm');
    expect(normalizeCapture({ format: 'png' }).format).toBe('png');
    expect(normalizeCapture({ format: 'avi' } as unknown as Partial<typeof DEFAULT_CAPTURE>).format).toBe(
      'webm',
    );
  });

  it('makes the dimensions even, because no video encoder takes an odd one', () => {
    const settings = normalizeCapture({ width: 1081, height: 607 });

    expect(settings.width % 2).toBe(0);
    expect(settings.height % 2).toBe(0);
    expect(settings).toMatchObject({ width: 1080, height: 606 });
  });

  it('clamps every field rather than refusing the settings', () => {
    const settings = normalizeCapture({
      width: 100_000,
      height: 0,
      fps: 0,
      duration: -5,
      loops: 0,
      startTime: -1,
      subframes: 1000,
      shutter: 4,
      supersample: 16,
    });

    expect(settings.width).toBe(MAX_CAPTURE_SIZE);
    expect(settings.height).toBe(16);
    expect(settings.fps).toBe(1);
    expect(settings.duration).toBeGreaterThan(0);
    expect(settings.loops).toBe(1);
    expect(settings.startTime).toBe(0);
    expect(settings.subframes).toBe(32);
    expect(settings.shutter).toBe(1);
    expect(settings.supersample).toBe(4);
  });

  it('survives the numbers a half-typed form produces', () => {
    const settings = normalizeCapture({ width: Number.NaN, fps: Number.POSITIVE_INFINITY });

    expect(Number.isFinite(settings.width)).toBe(true);
    expect(settings.fps).toBe(240);
  });
});

describe('planCapture', () => {
  it('lays the frames out on the frame grid, from the start time', () => {
    const plan = planCapture({ fps: 30, duration: 2, startTime: 5 });

    expect(plan.loopFrames).toBe(60);
    expect(plan.frames[0].time).toBeCloseTo(5);
    expect(plan.frames[1].time).toBeCloseTo(5 + 1 / 30);
    expect(plan.frames[59].time).toBeCloseTo(5 + 59 / 30);
  });

  it('leaves the window half-open, so a loop does not stutter at the seam', () => {
    const plan = planCapture({ fps: 60, duration: 4 });
    const last = plan.frames.at(-1)!;

    // The frame at t = duration *is* the frame at t = 0 of the next pass. Emitting
    // both would show the same picture twice at the join.
    expect(last.time).toBeLessThan(4);
    expect(last.time).toBeCloseTo(4 - 1 / 60);
    expect(last.time + 1 / 60).toBeCloseTo(plan.frames[0].time + 4);
  });

  it('is a pure function of the settings: the same request plans the same frames', () => {
    const settings = { fps: 24, duration: 3, startTime: 1.5, subframes: 4 };

    expect(planCapture(settings)).toEqual(planCapture(settings));
  });

  it('repeats a loop without re-rendering it', () => {
    const once = planCapture({ fps: 30, duration: 2, loops: 1 });
    const thrice = planCapture({ fps: 30, duration: 2, loops: 3 });

    // Three times the footage…
    expect(thrice.outputFrames).toBe(180);
    expect(thrice.outputDuration).toBeCloseTo(6);

    // …for exactly the same amount of drawing.
    expect(thrice.frames).toEqual(once.frames);
    expect(thrice.draws).toBe(once.draws);

    // And the second pass replays the first, frame for frame.
    expect(thrice.timeline.slice(0, 60)).toEqual(thrice.timeline.slice(60, 120));
    expect(thrice.timeline.at(-1)).toBe(59);
  });

  it('takes one sample per frame when motion blur is off', () => {
    const plan = planCapture({ fps: 60, duration: 1, subframes: 1, shutter: 0.5 });

    for (const frame of plan.frames) expect(frame.samples).toEqual([frame.time]);
    expect(plan.draws).toBe(plan.loopFrames);
  });

  it('spreads the shutter samples forward across the interval it stays open', () => {
    const plan = planCapture({ fps: 50, duration: 1, subframes: 4, shutter: 0.5 });
    const open = 0.5 / 50;
    const frame = plan.frames[10];

    expect(frame.samples).toHaveLength(4);
    // Midpoints of four equal slices of the open interval — never the closed ends,
    // which would weight the shutter's edges twice.
    expect(frame.samples[0]).toBeCloseTo(frame.time + open * 0.125);
    expect(frame.samples[3]).toBeCloseTo(frame.time + open * 0.875);

    for (const sample of frame.samples) {
      expect(sample).toBeGreaterThan(frame.time);
      expect(sample).toBeLessThan(frame.time + open);
    }

    // Motion blur is paid for in draws, not in frames.
    expect(plan.outputFrames).toBe(50);
    expect(plan.draws).toBe(200);
  });

  it('closing the shutter turns motion blur off, however many subframes were asked for', () => {
    const plan = planCapture({ subframes: 8, shutter: 0 });

    for (const frame of plan.frames) expect(frame.samples).toEqual([frame.time]);
  });

  it('supersamples by drawing bigger, and keeps both sizes even', () => {
    const plan = planCapture({ width: 1920, height: 1080, supersample: 2 });

    expect(plan).toMatchObject({
      width: 1920,
      height: 1080,
      renderWidth: 3840,
      renderHeight: 2160,
    });

    const odd = planCapture({ width: 1920, height: 1080, supersample: 1.5 });
    expect(odd.renderWidth % 2).toBe(0);
    expect(odd.renderHeight % 2).toBe(0);
  });

  it('never plans an empty capture, however short the window', () => {
    const plan = planCapture({ fps: 60, duration: 0.001 });

    expect(plan.loopFrames).toBe(1);
    expect(plan.frames).toHaveLength(1);
    expect(plan.timeline).toEqual([0]);
  });
});

describe('sequence naming', () => {
  it('pads to four digits, which is what everyone types into ffmpeg', () => {
    expect(sequencePadding(60)).toBe(4);
    expect(frameName('waves', 7, 60)).toBe('waves-0007.png');
  });

  it('grows the padding rather than letting a long capture sort wrongly', () => {
    expect(sequencePadding(20_000)).toBe(5);
    expect(frameName('waves', 12_345, 20_000)).toBe('waves-12345.png');
  });

  it('keeps a lexical sort a temporal one', () => {
    const names = [0, 1, 9, 10, 99, 100].map((index) => frameName('waves', index, 200));

    expect([...names].sort()).toEqual(names);
  });

  it('hands back the ffmpeg command for the sequence it just named', () => {
    const plan = planCapture({ fps: 30, duration: 2 });

    expect(ffmpegCommand('waves', plan)).toContain('-framerate 30');
    expect(ffmpegCommand('waves', plan)).toContain('-i waves-%04d.png');
  });
});
