/** A full-screen triangle; the fragment shader does all the drawing. */
export const GROVE_VERTEX_SHADER = /* glsl */ `
attribute vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }
`;

/**
 * The sampled grove: a 5 × 5 grid of crowns whose radii sample one travelling wave. The preview,
 * the small marks and the transparent export share this geometry; `geometry.ts` mirrors it at
 * time zero for static SVGs.
 */
export const GROVE_FRAGMENT_SHADER = /* glsl */ `
precision highp float;
uniform vec2 u_resolution;
uniform float u_time;
uniform vec2 u_pointer;
uniform vec3 u_top;
uniform vec3 u_mid;
uniform vec3 u_bottom;
uniform float u_mono;
uniform float u_samples;
uniform vec3 u_mark; // The mark's square box: centre (device pixels, y up) and side.
uniform float u_field; // 1 behind the hero: the grove continues past the square.
uniform vec4 u_clear; // Device-pixel box (x0, y0, x1, y1, y up) the field keeps clear.
const float PI = 3.14159265;
void main() {
  // The 5 × 5 square fills 84% of its box.
  float px = 1.0 / (u_mark.z * 0.84);
  vec2 p = (gl_FragCoord.xy - u_mark.xy) * px;
  float phase = u_time * 0.5235987756;
  float n = u_samples;
  float pitch = 1.0 / n;
  vec2 cell = floor((p + 0.5) / pitch);
  bool inSquare = all(greaterThanEqual(cell, vec2(0.0))) && all(lessThanEqual(cell, vec2(n - 1.0)));
  if (!inSquare && u_field < 0.5) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec2 center = (cell + 0.5) * pitch - 0.5;
  float x = center.x;
  float wave = 0.30 * x + 0.11 * sin(2.0 * PI * x)
    + 0.09 * (sin(3.2 * x - phase) - sin(3.2 * x));
  float offWave = (center.y - wave) / 0.2;
  vec2 d = center - u_pointer;
  float nearPointer = exp(-dot(d, d) * 30.0);
  float onWave = clamp(exp(-offWave * offWave) + 0.7 * nearPointer, 0.0, 1.0);
  float radius = pitch * mix(n < 4.0 ? 0.24 : 0.17, 0.47, onWave);
  if (!inSquare) {
    // Beyond the square there is no wave: crowns shrink with distance from the mark, and
    // fade out before the canvas edges so the field never ends on a cut.
    radius = pitch * (0.14 * exp(-(length(center) - 0.5) / 0.45) + 0.18 * nearPointer);
    vec2 dotPx = u_mark.xy + center / px;
    vec2 edge = min(dotPx, u_resolution - dotPx);
    radius *= smoothstep(0.0, pitch / px, min(edge.x, edge.y));
    // No crowns under the caption and hint below the square.
    vec2 nearest = clamp(dotPx, u_clear.xy, u_clear.zw);
    if (length(dotPx - nearest) < radius / px) radius = 0.0;
  }
  // Crowns thinner than a pixel fade out instead of leaving antialiasing specks.
  float alpha = (1.0 - smoothstep(-px, px, length(p - center) - radius))
    * clamp(radius / px, 0.0, 1.0);
  float t = clamp(0.5 + 0.6 * (center.x - center.y), 0.0, 1.0);
  vec3 color = t < 0.5 ? mix(u_top, u_mid, t * 2.0) : mix(u_mid, u_bottom, t * 2.0 - 1.0);
  if (u_mono > 0.5) color = vec3(0.95, 0.95, 0.93);
  gl_FragColor = vec4(color * alpha, alpha);
}
`;
