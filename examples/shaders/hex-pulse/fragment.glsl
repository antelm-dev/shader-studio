precision highp float;

// Built-ins. `u_clickData` is the engine's ripple ring: each slot holds
// (x, y, birthTime) for a click, with birthTime <= 0 meaning "unused". The
// array length is substituted by the engine before compiling.
uniform vec2 iResolution;
uniform float iTime;
uniform vec4 iMouse;
uniform vec3 u_clickData[__MAX_WAVES__];

uniform float u_timeScale;
uniform float u_cellSize;
uniform float u_rotation;
uniform float u_edgeWidth;
uniform float u_edgeGlow;

uniform float u_pulseSpeed;
uniform float u_pulseWidth;
uniform float u_pulseDuration;
uniform float u_pulseLift;

uniform float u_breathAmount;
uniform float u_breathSpeed;
uniform float u_pointerRadius;

uniform vec3 u_colorBackground;
uniform vec3 u_colorCell;
uniform vec3 u_colorPulse;

uniform float u_exposure;
uniform float u_vignette;

varying vec2 vUv;

const int C_MAX_WAVES = __MAX_WAVES__;

float hash1(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453123);
}

mat2 rot(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

// ============================================================
// Hex grid.
//
// A hex lattice is two offset rectangular lattices interleaved. Sample the
// point against both and keep whichever centre is nearer: that nearest centre
// *is* the hexagon it belongs to. `gv` comes back as the offset from the cell
// centre, `id` as the centre itself — a stable per-cell identifier.
// ============================================================
const vec2 HEX = vec2(1.0, 1.7320508); // 1, sqrt(3)

vec4 hexCells(vec2 p) {
  vec2 a = mod(p, HEX) - HEX * 0.5;
  vec2 b = mod(p - HEX * 0.5, HEX) - HEX * 0.5;
  vec2 gv = dot(a, a) < dot(b, b) ? a : b;
  return vec4(gv, p - gv);
}

/** Distance to the hexagon's edge: 0 at the border, ~0.5 at the centre. */
float hexEdge(vec2 gv) {
  vec2 p = abs(gv);
  return 0.5 - max(dot(p, HEX * 0.5), p.x);
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  float aspect = iResolution.x / iResolution.y;
  vec2 uv = vec2((vUv.x - 0.5) * aspect, vUv.y - 0.5);
  float t = iTime * u_timeScale;

  vec2 p = rot(u_rotation) * uv * u_cellSize;

  vec4 cell = hexCells(p);
  vec2 gv = cell.xy;
  vec2 id = cell.zw;

  // Back to screen space, so pulses travel at a speed you can reason about
  // rather than one that depends on the current cell size.
  vec2 cellCentre = (rot(-u_rotation) * id) / u_cellSize;

  float seed = hash1(id);

  // ---------------------------------------------------------
  // Energy per cell. Everything below adds into this, and it drives both the
  // cell's fill and how brightly its rim burns.
  // ---------------------------------------------------------
  float energy = 0.0;

  // A slow, per-cell breathing so the grid is alive before anything is clicked.
  energy += u_breathAmount * (0.5 + 0.5 * sin(t * u_breathSpeed + seed * 6.2831853));

  // Click pulses: an expanding ring per live slot.
  for (int i = 0; i < C_MAX_WAVES; ++i) {
    float birth = u_clickData[i].z;
    if (birth <= 0.0) continue;

    float age = iTime - birth;
    if (age < 0.0 || age >= u_pulseDuration) continue;

    // The ring is in the same space as cellCentre.
    vec2 origin = u_clickData[i].xy / iResolution.xy;
    vec2 c = vec2((origin.x - 0.5) * aspect, origin.y - 0.5);

    float distance = length(cellCentre - c);
    float front = age * u_pulseSpeed;

    // A cell lights as the wavefront crosses it, then fades.
    float ring = smoothstep(u_pulseWidth, 0.0, abs(distance - front));
    float fade = 1.0 - smoothstep(u_pulseDuration * 0.55, u_pulseDuration, age);

    energy += ring * fade * u_pulseLift;
  }

  // Pointer: cells near the cursor glow, so the grid responds to a hover too.
  bool pointerActive = iMouse.x >= 0.0 && iMouse.x <= iResolution.x &&
                       iMouse.y >= 0.0 && iMouse.y <= iResolution.y;

  if (pointerActive && u_pointerRadius > 0.0) {
    vec2 mouse = iMouse.xy / iResolution.xy;
    vec2 m = vec2((mouse.x - 0.5) * aspect, mouse.y - 0.5);
    float d = length(cellCentre - m);
    energy += smoothstep(u_pointerRadius, 0.0, d) * (0.35 + iMouse.z * 0.5);
  }

  energy = clamp(energy, 0.0, 2.0);

  // ---------------------------------------------------------
  // Draw the cell.
  //
  // fwidth gives the edge a constant *pixel* width, so the rim stays crisp at
  // any cell size instead of dissolving as the grid gets denser.
  // ---------------------------------------------------------
  float edge = hexEdge(gv);
  float aa = fwidth(edge) * 1.5;
  float rim = 1.0 - smoothstep(u_edgeWidth, u_edgeWidth + aa, edge);
  float fill = smoothstep(u_edgeWidth, u_edgeWidth + aa * 2.0, edge);

  vec3 color = u_colorBackground;
  color = mix(color, u_colorCell, fill * (0.25 + 0.75 * energy));
  color += u_colorPulse * rim * u_edgeGlow * (0.15 + energy);
  color += u_colorPulse * fill * energy * 0.35;

  color *= u_exposure;
  color = aces(color);

  float vignette = 1.0 - u_vignette * pow(length(vUv - 0.5) * 1.4, 2.2);
  color *= clamp(vignette, 0.0, 1.0);

  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
