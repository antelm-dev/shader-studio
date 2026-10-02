import type { NumberControl } from '@shadergrove/shared/model';

/** How far a drag travels to sweep a control from its minimum to its maximum. */
const FULL_RANGE_PX = 240;

/**
 * The value a number control takes after its label has been dragged `dx`
 * pixels from where the gesture started: the whole range over a fixed distance
 * (so every control scrubs at the same feel, whatever its units), a tenth of
 * that with `fine`, snapped to the control's step and kept inside its range.
 */
export function scrubValue(
  control: Pick<NumberControl, 'min' | 'max' | 'step'>,
  start: number,
  dx: number,
  fine: boolean,
): number {
  const { min, max, step } = control;
  const perPixel = ((max - min) / FULL_RANGE_PX) * (fine ? 0.1 : 1);

  let value = start + dx * perPixel;
  if (step && step > 0) value = min + Math.round((value - min) / step) * step;
  value = Math.min(max, Math.max(min, value));

  // Snapping leaves binary noise behind (0.30000000000000004), which would
  // show in the field and be written into the shader's parameters.
  return Number(value.toPrecision(12));
}
