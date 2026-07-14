export type CaptureFormat = 'webm' | 'png';

/**
 * How a shader is filmed.
 *
 * Every field is a *request*: the numbers a user typed, not the numbers the
 * capture will run at. `planCapture` is what turns one of these into a frame
 * timetable, and it clamps and rounds along the way.
 */
export interface CaptureSettings {
  format: CaptureFormat;
  width: number;
  height: number;
  fps: number;
  duration: number;
  loops: number;
  startTime: number;
  subframes: number;
  shutter: number;
  supersample: number;
}

export const DEFAULT_CAPTURE: CaptureSettings = {
  format: 'webm',
  width: 1920,
  height: 1080,
  fps: 60,
  duration: 8,
  loops: 1,
  startTime: 0,
  subframes: 1,
  shutter: 0.5,
  supersample: 1,
};
