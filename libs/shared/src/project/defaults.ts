import type { BufferSlot } from './types';

export const DEFAULT_VERTEX = `varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const DEFAULT_COMMON = `// Shared by every pass. Anything declared here is available in
// the Image pass and in every buffer, without an #include.

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  return fract(p * (p + p));
}
`;

export function defaultBufferSource(slot: BufferSlot): string {
  return `precision highp float;

uniform vec2 iResolution;
uniform float iTime;
uniform sampler2D iChannel0;

// Buffer ${slot} renders to a texture. Bind it to an iChannel of another pass
// (or of this one, with feedback, to read the frame you drew last tick).
void main() {
  vec2 uv = gl_FragCoord.xy / iResolution;
  gl_FragColor = vec4(uv, 0.5 + 0.5 * sin(iTime), 1.0);
}
`;
}

export function defaultFileSource(name: string): string {
  return `// ${name}
// Reach this from a pass with:  #include "${name}"
`;
}
