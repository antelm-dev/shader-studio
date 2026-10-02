import { groveSvgCircles, type GrovePalette, type GroveSamples } from '@shadergrove/brand';
import type { SVGProps } from 'react';

interface StaticGroveProps extends Omit<SVGProps<SVGSVGElement>, 'viewBox'> {
  readonly palette: GrovePalette;
  readonly mono?: boolean;
  readonly samples?: GroveSamples;
  /** Side of the viewBox. */
  readonly size?: number;
  /** Not in React's SVG types, but honoured by the global `[hidden]` rule. */
  readonly hidden?: boolean;
}

/** The canonical still as inline SVG, for the header mark and the no-WebGL fallback. */
export function StaticGrove({
  palette,
  mono = false,
  samples = 5,
  size = 600,
  ...svg
}: StaticGroveProps) {
  return (
    <svg viewBox={`0 0 ${size} ${size}`} {...svg}>
      {groveSvgCircles({ palette, size, samples, mono }).map(({ cx, cy, r, fill }) => (
        <circle key={`${cx},${cy}`} cx={cx} cy={cy} r={r} fill={fill} />
      ))}
    </svg>
  );
}
