precision highp float;

uniform vec2 iResolution;
uniform float iTime;
uniform vec4 iMouse;

uniform float u_speed;
uniform float u_depth;
uniform float u_twist;
uniform float u_rings;
uniform float u_spokes;
uniform float u_lineWidth;

// A `select` control: the GUI shows names, the uniform receives the number.
uniform float u_paletteMode;
// A `boolean` control arrives as a real GLSL bool.
uniform bool u_mirror;
uniform bool u_steering;

uniform vec3 u_colorNear;
uniform vec3 u_colorFar;
uniform vec3 u_colorLine;

uniform float u_chroma;
uniform float u_coreGlow;
uniform float u_fog;
uniform float u_exposure;
uniform float u_vignette;

varying vec2 vUv;

float hash1(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453123);
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

// ============================================================
// The tunnel.
//
// The trick is the reciprocal: depth = 1/r. A point near the centre of the
// screen maps to a huge depth, one near the edge to a small one — which is
// exactly what perspective does to an infinite cylinder seen end-on. Advance
// that depth with time and the tunnel flies at you, with no raymarching and no
// matrices.
//
// Returns the line lattice at a given depth offset, which is what lets the
// three colour channels be sampled at slightly different depths for dispersion.
// ============================================================
float lattice(vec2 p, float depthOffset) {
  float r = max(length(p), 0.001);
  float angle = atan(p.y, p.x) / 6.2831853; // -0.5 .. 0.5

  float depth = u_depth / r + iTime * u_speed + depthOffset;

  // Twisting the angular coordinate by depth is what turns a straight tube
  // into a helix; without it the spokes are rigid and the motion reads as flat.
  vec2 tube = vec2(
    (angle + depth * u_twist) * u_spokes,
    depth * u_rings
  );

  // Distance to the nearest grid line, in cell units.
  vec2 grid = abs(fract(tube) - 0.5);
  float d = min(grid.x, grid.y);

  // Constant pixel width: without fwidth the far end of the tunnel aliases
  // into static, because thousands of lines land inside one pixel.
  float aa = fwidth(d) * 1.4 + 0.001;
  float line = 1.0 - smoothstep(u_lineWidth, u_lineWidth + aa, d);

  // Fade with distance, or the vanishing point is a solid block of lines.
  return line * exp(-depth * u_fog * 0.02);
}

/** Palette modes for the `select` control: 0 classic, 1 neon, 2 ember. */
vec3 lineColor(float energy, float r) {
  if (u_paletteMode < 0.5) {
    return u_colorLine * energy;
  }
  if (u_paletteMode < 1.5) {
    // Neon: the line hue shifts with radius, so the tube reads as lit from
    // inside rather than uniformly painted.
    vec3 shifted = mix(u_colorLine, u_colorNear, clamp(r * 1.8, 0.0, 1.0));
    return shifted * energy * 1.15;
  }
  // Ember: lines cool from white-hot at the core to the far colour at the rim.
  vec3 hot = mix(vec3(1.0, 0.95, 0.85), u_colorLine, clamp(r * 2.2, 0.0, 1.0));
  return hot * energy;
}

void main() {
  float aspect = iResolution.x / iResolution.y;
  vec2 p = vec2((vUv.x - 0.5) * aspect, vUv.y - 0.5);

  // Steering: the tunnel leans towards the pointer, so it feels flown rather
  // than watched.
  if (u_steering) {
    bool pointerActive = iMouse.x >= 0.0 && iMouse.x <= iResolution.x &&
                         iMouse.y >= 0.0 && iMouse.y <= iResolution.y;
    if (pointerActive) {
      vec2 mouse = iMouse.xy / iResolution.xy - 0.5;
      p -= vec2(mouse.x * aspect, mouse.y) * 0.35;
    }
  }

  if (u_mirror) {
    p.x = abs(p.x);
  }

  float r = max(length(p), 0.001);

  // ---------------------------------------------------------
  // Dispersion: sample the lattice at three slightly different depths, one per
  // channel. Prisms split light by wavelength; this is the cheap version of
  // that, and it only shows where the lattice is moving fastest — near the core.
  // ---------------------------------------------------------
  float spread = u_chroma * 0.02;
  vec3 energy = vec3(
    lattice(p, -spread),
    lattice(p, 0.0),
    lattice(p, spread)
  );

  // Background: the tube itself, dark at the vanishing point.
  vec3 color = mix(u_colorNear, u_colorFar, clamp(1.0 - r * 1.6, 0.0, 1.0));
  color *= smoothstep(0.0, 0.35, r); // the core is a hole, not a wall

  color += lineColor(energy.g, r);

  // Fold the per-channel offsets back in as a colour fringe on the lines.
  color.r += (energy.r - energy.g) * u_chroma * 0.6;
  color.b += (energy.b - energy.g) * u_chroma * 0.6;

  // The light at the end of it.
  color += u_colorLine * u_coreGlow * exp(-r * 9.0);

  color *= u_exposure;
  color = aces(color);

  float vignette = 1.0 - u_vignette * pow(length(vUv - 0.5) * 1.4, 2.2);
  color *= clamp(vignette, 0.0, 1.0);

  // The radial gradient is long and shallow; it bands badly without a dither.
  color += (hash1(gl_FragCoord.xy * 1.7 + fract(iTime)) - 0.5) / 255.0;

  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
