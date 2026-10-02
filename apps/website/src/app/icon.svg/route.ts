import { GROVE_PALETTES, groveSvg } from '@shadergrove/brand';

// Prerendered to out/icon.svg by the static export.
export const dynamic = 'force-static';

/** The favicon: the small 3 × 3 mark, drawn from the same geometry as the shader. */
export function GET() {
  return new Response(groveSvg({ palette: GROVE_PALETTES.grove, size: 36, samples: 3 }), {
    headers: { 'Content-Type': 'image/svg+xml' },
  });
}
