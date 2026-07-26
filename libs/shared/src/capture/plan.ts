import { DEFAULT_CAPTURE, type CaptureSettings } from './types';
/**
 * The timetable a capture is played from.
 *
 * Everything here is pure arithmetic on the settings — no canvas, no GPU, no
 * clock. That is the whole point: a captured frame must be a function of its
 * index and nothing else, so that the same shader filmed twice gives the same
 * pixels twice. The live renderer takes its time from `performance.now()`
 * (`ShaderEngine.tick`), which is exactly what a capture cannot do.
 *
 * So the plan is computed up front, the engine is told to draw at each instant
 * in it, and the wall clock never enters into it.
 */

// -----------------------------------------------------------------------------
// Limits
// -----------------------------------------------------------------------------

export const MIN_CAPTURE_SIZE = 16;
/** 8K. Past this a browser will refuse the render target long before the user runs out of patience. */
export const MAX_CAPTURE_SIZE = 7680;

export const MAX_CAPTURE_FPS = 240;
export const MAX_CAPTURE_DURATION = 600;
export const MAX_CAPTURE_LOOPS = 100;
export const MAX_CAPTURE_SUBFRAMES = 32;
export const MAX_CAPTURE_SUPERSAMPLE = 4;

// -----------------------------------------------------------------------------
// Plan
// -----------------------------------------------------------------------------

/** One frame the engine will be asked to draw. */
export interface CaptureFrame {
  /** Index within the loop, from 0. */
  readonly index: number;
  /** The `iTime` this frame is nominally taken at. */
  readonly time: number;
  /**
   * The instants averaged into it. Exactly `[time]` unless motion blur is on,
   * in which case the shutter opens *at* `time` and the samples spread forward
   * across the interval it stays open.
   */
  readonly samples: readonly number[];
}

export interface CapturePlan {
  /** The settings as they will actually run: clamped, rounded, made even. */
  readonly settings: CaptureSettings;

  /** The size written out. Always even — VP9 and H.264 both reject odd dimensions. */
  readonly width: number;
  readonly height: number;

  /** The size actually drawn. Larger than the output when supersampling. */
  readonly renderWidth: number;
  readonly renderHeight: number;

  /** Every distinct frame to draw, in order. One pass of the loop, never more. */
  readonly frames: readonly CaptureFrame[];

  /**
   * Output frame *n* is `frames[timeline[n]]`.
   *
   * Repeating the loop repeats this array, not the rendering: a shader that is
   * periodic over the captured window shows *the same pixels* on its second
   * pass, so drawing them again would be work with a known answer. Ten loops of
   * eight seconds costs eight seconds of GPU time.
   */
  readonly timeline: readonly number[];

  /** Frames in one pass of the loop. */
  readonly loopFrames: number;
  /** Frames written out: `loopFrames × loops`. */
  readonly outputFrames: number;
  /** Seconds of footage written out. */
  readonly outputDuration: number;
  /** Shader instants drawn: `loopFrames × subframes`. What the export actually costs. */
  readonly draws: number;
}

// -----------------------------------------------------------------------------
// Normalisation
// -----------------------------------------------------------------------------

/** `NaN` is the one value with no natural side to fall to; the infinities clamp themselves. */
function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function clampInt(value: number, min: number, max: number): number {
  return Math.round(clamp(value, min, max));
}

/** Rounds down to an even number: an odd dimension is not one a video encoder will take. */
function even(value: number): number {
  return Math.max(MIN_CAPTURE_SIZE, Math.floor(value / 2) * 2);
}

/**
 * The settings as they can actually be honoured. Never throws: a capture dialog
 * that refuses to open because a field is momentarily empty is worse than one
 * that shows what the number will be rounded to.
 */
export function normalizeCapture(settings: Partial<CaptureSettings> = {}): CaptureSettings {
  const merged = { ...DEFAULT_CAPTURE, ...settings };

  return {
    format: merged.format === 'png' ? 'png' : 'webm',
    width: even(clampInt(merged.width, MIN_CAPTURE_SIZE, MAX_CAPTURE_SIZE)),
    height: even(clampInt(merged.height, MIN_CAPTURE_SIZE, MAX_CAPTURE_SIZE)),
    fps: clampInt(merged.fps, 1, MAX_CAPTURE_FPS),
    duration: clamp(merged.duration, 1 / MAX_CAPTURE_FPS, MAX_CAPTURE_DURATION),
    loops: clampInt(merged.loops, 1, MAX_CAPTURE_LOOPS),
    startTime: clamp(merged.startTime, 0, MAX_CAPTURE_DURATION),
    subframes: clampInt(merged.subframes, 1, MAX_CAPTURE_SUBFRAMES),
    shutter: clamp(merged.shutter, 0, 1),
    supersample: clamp(merged.supersample, 1, MAX_CAPTURE_SUPERSAMPLE),
  };
}

// -----------------------------------------------------------------------------
// Planning
// -----------------------------------------------------------------------------

/**
 * The instants to average into the frame taken at `time`.
 *
 * The shutter opens at `time` and closes a fraction of a frame later, and the
 * samples sit at the centres of the equal slices in between — so the average is
 * a midpoint rule over the interval the shutter was open, not a lopsided one
 * that double-counts either end.
 *
 * The last frame of a loop samples slightly *past* the end of the window, which
 * is exactly right: on a shader that is periodic over that window, past the end
 * is the beginning, so the blur wraps as seamlessly as the loop does.
 */
function shutterSamples(time: number, subframes: number, shutter: number, fps: number): number[] {
  if (subframes <= 1 || shutter <= 0) return [time];

  const open = shutter / fps;
  return Array.from(
    { length: subframes },
    (_, sample) => time + ((sample + 0.5) / subframes) * open,
  );
}

/** Turns what the user asked for into the frames the engine will be told to draw. */
export function planCapture(settings: Partial<CaptureSettings> = {}): CapturePlan {
  const normalized = normalizeCapture(settings);
  const { fps, duration, loops, startTime, subframes, shutter, supersample } = normalized;

  // Round, and keep at least one: a window shorter than a frame is still a
  // frame, and a plan with no frames is a plan that cannot fail visibly.
  const loopFrames = Math.max(1, Math.round(duration * fps));

  // The window is half-open: the frame at `startTime + duration` is the frame at
  // `startTime` of the next pass. Emitting both is what puts a stutter in a loop
  // that should have been seamless.
  const frames: CaptureFrame[] = Array.from({ length: loopFrames }, (_, index) => {
    const time = startTime + index / fps;
    return { index, time, samples: shutterSamples(time, subframes, shutter, fps) };
  });

  const timeline: number[] = [];
  for (let loop = 0; loop < loops; loop++) {
    for (let index = 0; index < loopFrames; index++) timeline.push(index);
  }

  return {
    settings: normalized,
    width: normalized.width,
    height: normalized.height,
    renderWidth: even(Math.round(normalized.width * supersample)),
    renderHeight: even(Math.round(normalized.height * supersample)),
    frames,
    timeline,
    loopFrames,
    outputFrames: timeline.length,
    outputDuration: timeline.length / fps,
    draws: loopFrames * subframes,
  };
}

/**
 * Where a rendered frame lands in the output — in more than one place, once the
 * loop repeats.
 *
 * This is what lets a looped capture be encoded without being re-rendered: the
 * frame is drawn once, and the same pixels are written out at every position the
 * timeline sends them to.
 */
export function outputIndices(plan: CapturePlan, frameIndex: number): number[] {
  return Array.from(
    { length: plan.settings.loops },
    (_, loop) => frameIndex + loop * plan.loopFrames,
  );
}

// -----------------------------------------------------------------------------
// Naming
// -----------------------------------------------------------------------------

/** Digits a sequence of `count` frames needs. Four at minimum, because `%04d` is what everyone types. */
export function sequencePadding(count: number): number {
  return Math.max(4, String(Math.max(count - 1, 0)).length);
}

/** `shader-0000.png` — zero-padded, from 0, so a lexical sort is a temporal one. */
export function frameName(stem: string, index: number, count: number): string {
  return `${stem}-${String(index).padStart(sequencePadding(count), '0')}.png`;
}

/**
 * The command that turns the sequence into a video, ready to be shown next to
 * the finished export. Handing a folder of PNGs to someone without this is
 * handing them homework.
 */
export function ffmpegCommand(stem: string, plan: CapturePlan): string {
  const pattern = `${stem}-%0${sequencePadding(plan.outputFrames)}d.png`;
  return `ffmpeg -framerate ${plan.settings.fps} -i ${pattern} -c:v libx264 -crf 17 -pix_fmt yuv420p ${stem}.mp4`;
}
