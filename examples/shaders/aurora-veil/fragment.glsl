precision highp float;

// Built-ins, always supplied by the engine.
uniform vec2 iResolution;
uniform float iTime;
uniform vec4 iMouse; // xy: pixel coords, z: 1 while the pointer is down

// One uniform per control in meta.json, named u_<key>.
uniform float u_timeScale;
uniform float u_curtainScale;
uniform float u_flowSpeed;
uniform float u_waviness;
uniform float u_bandSharpness;
uniform float u_intensity;
uniform float u_horizon;
uniform float u_veilHeight;
uniform float u_rayStrength;

uniform vec3 u_colorLow;
uniform vec3 u_colorHigh;
uniform vec3 u_colorSky;

uniform float u_starDensity;
uniform float u_starBrightness;
uniform float u_pointerGlow;

uniform float u_exposure;
uniform float u_vignette;

varying vec2 vUv;

// ============================================================
// Noise
// ============================================================
float hash1(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453123);
}

vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}

float gnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0); // quintic, C2-continuous
  return 1.4 * mix(
    mix(dot(hash2(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0)),
        dot(hash2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
    mix(dot(hash2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)),
        dot(hash2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * gnoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}

// Filmic roll-off, so the brightest folds of the veil bloom instead of clipping.
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  float aspect = iResolution.x / iResolution.y;
  vec2 p = vec2((vUv.x - 0.5) * aspect, vUv.y);
  float t = iTime * u_timeScale;

  // ---------------------------------------------------------
  // Sky and stars, drawn first so the veil glows over them.
  // ---------------------------------------------------------
  vec3 color = u_colorSky * (1.0 - vUv.y * 0.45);

  vec2 starGrid = vUv * vec2(aspect, 1.0) * u_starDensity;
  vec2 cell = floor(starGrid);
  float seed = hash1(cell);

  // Jitter each star inside its cell, or the field reads as a lattice.
  vec2 offset = fract(starGrid) - 0.5 - 0.3 * hash2(cell);
  float star = smoothstep(0.07, 0.0, length(offset)) * step(0.94, seed);
  star *= 0.55 + 0.45 * sin(iTime * 2.5 + seed * 40.0); // twinkle
  color += vec3(star) * u_starBrightness;

  // ---------------------------------------------------------
  // The veil.
  //
  // A curtain is a vertical sheet whose *horizontal position* wanders. So the
  // x axis gets warped by a slow noise field and everything downstream is
  // built on the warped axis — that is what makes the folds drape rather than
  // just wobble in place.
  // ---------------------------------------------------------
  float drift = fbm(vec2(p.x * u_curtainScale * 0.5, t * u_flowSpeed)) * u_waviness;
  float x = p.x + drift;

  float band = fbm(vec2(x * u_curtainScale, t * u_flowSpeed * 1.7 + p.y * 0.6));
  band = pow(clamp(band * 0.5 + 0.5, 0.0, 1.0), u_bandSharpness);

  // The veil hangs in a layer: it fades in above the horizon and out at the top.
  float top = u_horizon + u_veilHeight;
  float mask = smoothstep(u_horizon, u_horizon + u_veilHeight * 0.35, p.y)
             * (1.0 - smoothstep(top * 0.75, top, p.y));

  float curtain = band * mask;

  // Fine vertical striations: charged particles spiralling down field lines.
  float rays = fbm(vec2(x * u_curtainScale * 4.5, p.y * 2.0 - t * 0.35)) * 0.5 + 0.5;
  curtain *= mix(1.0 - u_rayStrength, 1.0 + u_rayStrength, rays);

  // Green at the base, magenta at the crest — the real thing does this because
  // the emission altitude changes which atmospheric line dominates.
  float altitude = clamp((p.y - u_horizon) / max(u_veilHeight, 0.001), 0.0, 1.0);
  vec3 veil = mix(u_colorLow, u_colorHigh, altitude);

  color += veil * curtain * u_intensity;

  // ---------------------------------------------------------
  // Pointer: a soft bloom of the same emission colour.
  // ---------------------------------------------------------
  bool pointerActive = iMouse.x >= 0.0 && iMouse.x <= iResolution.x &&
                       iMouse.y >= 0.0 && iMouse.y <= iResolution.y;

  if (pointerActive && u_pointerGlow > 0.0) {
    vec2 mouse = iMouse.xy / iResolution.xy;
    vec2 m = vec2((mouse.x - 0.5) * aspect, mouse.y);
    float d = length(p - m);
    float glow = exp(-d * 7.0) * (1.0 + iMouse.z * 0.8);
    color += veil * glow * u_pointerGlow;
  }

  // ---------------------------------------------------------
  // Grade
  // ---------------------------------------------------------
  color *= u_exposure;
  color = aces(color);

  float vignette = 1.0 - u_vignette * pow(length(vUv - 0.5) * 1.4, 2.2);
  color *= clamp(vignette, 0.0, 1.0);

  // Sub-LSB dither: the sky is a long, shallow gradient and will band without it.
  color += (hash1(gl_FragCoord.xy * 1.7 + fract(iTime)) - 0.5) / 255.0;

  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
