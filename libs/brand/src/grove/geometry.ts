import { hexToRgb, MONO_INK, type GrovePalette, type Rgb } from './palettes';

/** The square of crowns fills this share of its box (a canvas, or an SVG viewBox). */
export const MARK_FILL = 0.84;
/** Below this displayed size, in CSS pixels, the mark simplifies to 3 × 3. */
export const SMALL_MARK_CSS_SIZE = 44;
/** One loop of the wave, in seconds; time zero is the canonical still. */
export const GROVE_LOOP_SECONDS = 12;

export type GroveSamples = 3 | 5;

/** One crown in mark units: the square spans -0.5..0.5 on both axes, y up. */
export interface Crown {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  /** Position along the diagonal colour gradient, 0..1. */
  readonly t: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const mix = (a: number, b: number, f: number) => a + (b - a) * f;

/** The wave every crown samples. Its drift is zero at phase 0, so the still is the logo. */
export function groveWave(x: number, phase = 0): number {
  return (
    0.3 * x +
    0.11 * Math.sin(2 * Math.PI * x) +
    0.09 * (Math.sin(3.2 * x - phase) - Math.sin(3.2 * x))
  );
}

/** The canonical still (time zero, no pointer), sized exactly as the fragment shader sizes it. */
export function groveCrowns(samples: GroveSamples = 5): Crown[] {
  const pitch = 1 / samples;
  const crowns: Crown[] = [];
  for (let row = 0; row < samples; row++) {
    for (let column = 0; column < samples; column++) {
      const x = (column + 0.5) * pitch - 0.5;
      const y = (row + 0.5) * pitch - 0.5;
      const offWave = (y - groveWave(x)) / 0.2;
      const onWave = clamp(Math.exp(-offWave * offWave), 0, 1);
      crowns.push({
        x,
        y,
        radius: pitch * mix(samples < 4 ? 0.24 : 0.17, 0.47, onWave),
        t: clamp(0.5 + 0.6 * (x - y), 0, 1),
      });
    }
  }
  return crowns;
}

/** A crown's colour (0..1) at gradient position `t`, matching the shader's two-segment mix. */
export function crownColor(palette: GrovePalette, t: number, mono = false): Rgb {
  if (mono) return MONO_INK;
  const [start, middle, end] = palette.colors.map(hexToRgb) as [Rgb, Rgb, Rgb];
  const [a, b, f] = t < 0.5 ? [start, middle, t * 2] : [middle, end, t * 2 - 1];
  return [mix(a[0], b[0], f), mix(a[1], b[1], f), mix(a[2], b[2], f)];
}

export interface SvgCircle {
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  readonly fill: string;
}

export interface GroveSvgOptions {
  readonly palette: GrovePalette;
  /** Side of the square viewBox. */
  readonly size: number;
  readonly samples?: GroveSamples;
  readonly mono?: boolean;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** The canonical still as circles in a `0 0 size size` viewBox (y down). */
export function groveSvgCircles({
  palette,
  size,
  samples = 5,
  mono = false,
}: GroveSvgOptions): SvgCircle[] {
  return groveCrowns(samples).map(({ x, y, radius, t }) => {
    const rgb = crownColor(palette, t, mono).map((channel) => Math.round(channel * 255));
    return {
      cx: round2((x * MARK_FILL + 0.5) * size),
      cy: round2((0.5 - y * MARK_FILL) * size),
      r: round2(radius * MARK_FILL * size),
      fill: `rgb(${rgb.join(',')})`,
    };
  });
}

/** The canonical still as a standalone SVG document, for favicons and static exports. */
export function groveSvg(options: GroveSvgOptions): string {
  const circles = groveSvgCircles(options)
    .map(({ cx, cy, r, fill }) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${options.size} ${options.size}">${circles}</svg>`;
}
