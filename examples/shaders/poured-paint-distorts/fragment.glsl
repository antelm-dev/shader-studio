precision highp float;

uniform vec2 iResolution;
uniform float iTime;
uniform vec4 iMouse;
uniform vec2 iMouseVel;

// --- Structure ---
uniform float u_timeScale;
uniform float u_warpIntensity;
uniform float u_warpScale;
uniform float u_detailScale;
uniform float u_roughnessAmount;
uniform float u_flowSpeed;
uniform float u_distortMode;
uniform float u_distortStrength;
uniform float u_distortFreq;
uniform float u_swirlTurns;

// Poured paint pools into discrete steps rather than a smooth gradient.
// Quantizing the height field into layers is what produces the hard
// contour lines between color bands.
uniform float u_layerCount;
uniform float u_layerSoftness;
uniform float u_layerVariation;
uniform float u_edgeDark;
uniform float u_edgeGloss;

const float CONTINUOUS_DISTORTION_STRENGTH = 0.045;
const float CONTINUOUS_EFFECT_RADIUS = 0.32;
const float SMEAR_STRENGTH = 0.05;

// --- Wet paint lighting ---
uniform float u_lightAngle;
uniform float u_lightElevation;
uniform float u_reliefStrength;
uniform float u_specularStrength;
uniform float u_glossiness;
uniform float u_ambient;

// --- Palette ---
uniform vec3 u_colorDeep;
uniform vec3 u_colorMid;
uniform vec3 u_colorLight;
uniform vec3 u_colorAccent;
uniform vec3 u_colorHighlight;
uniform float u_accentAmount;
uniform float u_paintContrast;

// --- Grade ---
uniform float u_exposure;
uniform float u_satFactor;
uniform float u_conFactor;
uniform float u_vignette;
uniform float u_grain;

varying vec2 vUv;

const float TAU = 6.2831853;

// ============================================================
// Color space: sRGB <-> linear <-> OKLab
// Palette ramps are interpolated in OKLab so mid-tones stay
// saturated instead of sliding through muddy grey.
// ============================================================
vec3 srgb2lin(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
vec3 lin2srgb(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }

vec3 lin2oklab(vec3 c) {
  float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  vec3 lms = pow(max(vec3(l, m, s), 0.0), vec3(1.0 / 3.0));
  return vec3(
    0.2104542553 * lms.x + 0.7936177850 * lms.y - 0.0040720468 * lms.z,
    1.9779984951 * lms.x - 2.4285922050 * lms.y + 0.4505937099 * lms.z,
    0.0259040371 * lms.x + 0.7827717662 * lms.y - 0.8086757660 * lms.z
  );
}

vec3 oklab2lin(vec3 c) {
  float l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s_ = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  vec3 lms = vec3(l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);
  return vec3(
     4.0767416621 * lms.x - 3.3077115913 * lms.y + 0.2309699292 * lms.z,
    -1.2684380046 * lms.x + 2.6097574011 * lms.y - 0.3413193965 * lms.z,
    -0.0041960863 * lms.x - 0.7034186147 * lms.y + 1.7076147010 * lms.z
  );
}

vec3 srgb2oklab(vec3 c) { return lin2oklab(srgb2lin(c)); }

// Hue rotation around the OKLab a/b plane — perceptually even, unlike HSV.
vec3 okHueRotate(vec3 lab, float turns) {
  float c = cos(TAU * turns), s = sin(TAU * turns);
  return vec3(lab.x, lab.y * c - lab.z * s, lab.y * s + lab.z * c);
}

// ============================================================
// Gradient (Perlin-style) noise — smoother and less grid-aligned
// than the value noise the original used.
// ============================================================
vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}

float hash1(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453123);
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

mat2 rot(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

// Rotating each octave by ~137.5deg keeps successive layers from
// stacking onto the same axes, which is what made the old fbm look ropey.
float fbm(vec2 p, float t) {
  float v = 0.0;
  float a = 0.5;
  vec2 x = p;
  for (int i = 0; i < 5; i++) {
    v += a * gnoise(x + vec2(t * 0.15, t * -0.1));
    x = rot(2.3999632) * x * 2.02;
    a *= 0.5;
  }
  return v;
}

vec2 domainWarp(vec2 p, float t, out vec2 q, out vec2 r) {
  q = vec2(fbm(p, t), fbm(p + vec2(5.2, 1.3), t));
  r = vec2(
    fbm(p + 4.0 * q + vec2(1.7, 9.2), t * 1.1),
    fbm(p + 4.0 * q + vec2(8.3, 2.8), t * 0.9)
  );
  return p + u_warpIntensity * 2.0 * r;
}

vec2 distortUv(vec2 uv, float t) {
  float s = u_distortStrength;
  float f = max(u_distortFreq, 0.01);
  int mode = int(floor(u_distortMode + 0.5));
  vec2 c = uv - 0.5;
  float r = length(c);
  float a = atan(c.y, c.x);

  if (mode <= 0 || s <= 0.0) {
    return uv;
  }

  if (mode == 1) {
    float twist = u_swirlTurns * TAU * s * smoothstep(0.65, 0.0, r);
    a += twist + 0.15 * s * sin(t * 0.7 + r * f * 6.0);
    return 0.5 + r * vec2(cos(a), sin(a));
  }

  if (mode == 2) {
    float wave = sin(r * f * 18.0 - t * 2.2) * s * 0.08;
    vec2 dir = c / max(r, 1e-4);
    return uv + dir * wave;
  }

  if (mode == 3) {
    float sectors = max(floor(f * 2.0 + 2.0), 2.0);
    float slice = TAU / sectors;
    a = mod(a, slice);
    a = abs(a - slice * 0.5);
    a += t * 0.05 * s;
    float kr = mix(r, pow(r, mix(1.0, 0.72, s)), s);
    return 0.5 + kr * vec2(cos(a), sin(a));
  }

  if (mode == 4) {
    vec2 cell = floor(uv * f * 4.0);
    vec2 local = fract(uv * f * 4.0) - 0.5;
    vec2 push = hash2(cell + floor(t * 0.4));
    return uv + push * s * 0.06 * (1.0 - length(local) * 1.4);
  }

  float sx = sin((uv.y + t * 0.08) * f * 8.0) * s * 0.07;
  float sy = cos((uv.x - t * 0.06) * f * 7.0) * s * 0.07;
  return uv + vec2(sx, sy);
}

vec2 toFlow(vec2 p) {
  return p;
}

// Height of the paint surface, sampled in flow space.
float heightAt(vec2 p, float t) {
  vec2 sp = p;
  sp.y -= t * u_flowSpeed;
  return fbm(sp * u_detailScale, t * 0.6);
}

// Quantize the height into pooled layers. Returns the stepped height; `edge`
// comes back as a thin ridge mask sitting on each layer boundary, which is
// where poured paint builds up a lip and catches the light.
//
// Where the height gradient is steep, layer boundaries pack in tighter than one
// pixel and the quantization aliases into noise. `w` is how far t travels per
// pixel (from fwidth), and it is used both to widen the transition to at least
// a pixel and to dissolve the layering back into the smooth field once the
// layers are too dense to resolve at all. Without this the steep regions turn
// into black static.
float layerize(float t, float w, out float edge, out float cellId, out float resolve) {
  float scaled = t * u_layerCount;
  float cellW = w * u_layerCount; // pixel footprint, in cell units

  // How resolvable the layers still are here: 1 = crisp, 0 = sub-pixel mush.
  resolve = 1.0 - smoothstep(0.30, 0.85, cellW);

  float soft = max(clamp(u_layerSoftness, 0.02, 0.49), cellW * 0.9);
  float cell = floor(scaled);
  float f = fract(scaled);

  float stepped = (cell + smoothstep(0.5 - soft, 0.5 + soft, f)) / u_layerCount;

  // The band a pixel belongs to flips at the midpoint of the cell, matching
  // where `stepped` transitions — so the per-layer tint and the value step
  // land on the same contour instead of half a cell apart.
  cellId = cell + step(0.5, f);

  float d = min(f, 1.0 - f); // distance to nearest boundary, in cell units
  edge = (1.0 - smoothstep(0.0, soft * 1.3, d)) * resolve;

  return mix(t, stepped, resolve);
}

vec2 safeNorm(vec2 v) {
  return v / max(length(v), 1e-4);
}

vec2 toAspect(vec2 uv, float aspect) {
  return aspect > 1.0
    ? vec2((uv.x - 0.5) * aspect + 0.5, uv.y)
    : vec2(uv.x, (uv.y - 0.5) / aspect + 0.5);
}

// Filmic tonemap — rolls off highlights instead of clipping them flat,
// which matters now that specular hits can push well past 1.0.
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

// Four octaves of fbm land in roughly [-0.6, 0.6] in practice, not [-1, 1].
// Ramp stops are placed against this remapped [0,1] range so the deep tones
// actually get used instead of everything piling up at the light end.
float toRampT(float h) {
  return clamp(0.5 + h * u_paintContrast, 0.0, 1.0);
}

// Palette ramp, evaluated in OKLab. `t` is normalized surface height, `veins`
// drives the accent color. Returns OKLab, not RGB, so the caller can
// hue-shift or split channels before paying for the conversion back.
vec3 rampOk(float t, float veins, vec3 okDeep, vec3 okMid, vec3 okLight, vec3 okAccent, vec3 okHi) {
  // Overlapping stops: disjoint ones let large regions settle exactly on a
  // single palette entry, which posterizes into flat slabs of color.
  vec3 c = mix(okDeep, okMid, smoothstep(0.05, 0.45, t));
  c = mix(c, okLight, smoothstep(0.45, 0.92, t));

  float accent = pow(smoothstep(0.35, 0.9, veins), 1.5) * u_accentAmount;
  c = mix(c, okAccent, accent);

  float hi = smoothstep(0.88, 1.0, t);
  c = mix(c, okHi, hi * 0.40 * (1.0 - accent * 0.6));

  // Keep a tonal gradient alive *inside* each band. OKLab's x is lightness,
  // so this shades the paint by height without touching its hue. The floor
  // stays high because the diffuse term darkens these same pixels again.
  c.x *= mix(0.85, 1.08, t);
  return c;
}

// The ramp plus this band's own identity. Kept as one function so the
// chromatic-aberration taps shade identically to the base color.
vec3 paintLab(
  float t, float veins, float jitter, float variation,
  vec3 okDeep, vec3 okMid, vec3 okLight, vec3 okAccent, vec3 okHi
) {
  vec3 c = rampOk(t, veins, okDeep, okMid, okLight, okAccent, okHi);
  c.x *= 1.0 + jitter * 0.55 * variation;
  c = okHueRotate(c, jitter * 0.06 * variation);
  c.yz *= 1.0 + jitter * 0.5 * variation; // chroma: some pours read richer
  return c;
}

void main() {
  float aspect = iResolution.x / iResolution.y;
  vec2 uv = toAspect(vUv, aspect);
  float time = iTime * u_timeScale;

  // ---------------------------------------------------------
  // Interaction: pointer smear displace the sampling position BEFORE the warp.
  // ---------------------------------------------------------
  vec2 p = distortUv(uv, time);

  bool pointerActive = iMouse.x >= 0.0 && iMouse.x <= iResolution.x &&
                       iMouse.y >= 0.0 && iMouse.y <= iResolution.y;

  if (pointerActive) {
    vec2 pointerUv = toAspect(iMouse.xy / iResolution.xy, aspect);
    vec2 toPointer = p - pointerUv;
    float dist = length(toPointer);

    if (dist < CONTINUOUS_EFFECT_RADIUS) {
      float falloff = smoothstep(CONTINUOUS_EFFECT_RADIUS, 0.0, dist);

      float push = CONTINUOUS_DISTORTION_STRENGTH * (1.0 + iMouse.z * 0.6);
      p += safeNorm(toPointer) * push * falloff;

      vec2 vel = iMouseVel / max(iResolution.y, 1.0);
      if (length(vel) > 3.0) vel = safeNorm(vel) * 3.0;
      p -= vel * SMEAR_STRENGTH * falloff;
    }
  }

  // ---------------------------------------------------------
  // Structure
  // ---------------------------------------------------------
  // Everything downstream is built in flow space, so the warp undulates the
  // strata rather than churning them into isotropic blobs.
  vec2 q, r;
  vec2 warped = domainWarp(toFlow(p) * u_warpScale, time * 0.2, q, r) / u_warpScale;

  // Fine tooth/grain in the medium — canvas texture, not noise for its own sake.
  vec2 tooth = vec2(
    gnoise(warped * 90.0 + time),
    gnoise(warped * 90.0 - time + vec2(13.7))
  ) * u_roughnessAmount;
  warped += tooth;

  float h = heightAt(warped, time);

  // Ridges of the second warp pass. length() keeps the accent on the sparse
  // high-energy filaments; dot(r,r) was positive everywhere and just tinted
  // the whole frame.
  float veins = clamp(length(r) * 2.0, 0.0, 1.5);

  // ---------------------------------------------------------
  // Surface normal from the height field, via finite differences.
  // This is the single biggest upgrade: the paint gets real relief
  // and a wet specular sheen instead of being a flat color map.
  // ---------------------------------------------------------
  float eps = 1.5 / min(iResolution.x, iResolution.y) + 0.0015;
  float hx = heightAt(warped + vec2(eps, 0.0), time);
  float hy = heightAt(warped + vec2(0.0, eps), time);
  vec3 n = normalize(vec3(
    -(hx - h) / eps * u_reliefStrength,
    -(hy - h) / eps * u_reliefStrength,
    1.0
  ));

  vec3 L = normalize(vec3(
    cos(u_lightAngle) * cos(u_lightElevation),
    sin(u_lightAngle) * cos(u_lightElevation),
    sin(u_lightElevation)
  ));
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 Hv = normalize(L + V);

  float diffuse = max(dot(n, L), 0.0);
  float spec = pow(max(dot(n, Hv), 0.0), u_glossiness) * u_specularStrength;
  float fresnel = pow(1.0 - max(dot(n, V), 0.0), 3.0); // grazing sheen on ridges

  // ---------------------------------------------------------
  // Color
  // ---------------------------------------------------------
  vec3 okDeep = srgb2oklab(u_colorDeep);
  vec3 okMid = srgb2oklab(u_colorMid);
  vec3 okLight = srgb2oklab(u_colorLight);
  vec3 okAccent = srgb2oklab(u_colorAccent);
  vec3 okHi = srgb2oklab(u_colorHighlight);

  float edge, cellId, resolve;
  float tRaw = toRampT(h);
  float t = layerize(tRaw, fwidth(tRaw), edge, cellId, resolve);

  // Each pooled band is a separate pour of paint, not a slice of one smooth
  // gradient, so it gets its own value and hue. Faded out wherever the layers
  // stop being resolvable, otherwise per-band jitter becomes per-pixel noise.
  float jitter = hash1(vec2(cellId, 3.7)) - 0.5;
  float variation = u_layerVariation * resolve;

  vec3 lab = paintLab(t, veins, jitter, variation, okDeep, okMid, okLight, okAccent, okHi);
  vec3 color = oklab2lin(lab);

  // ---------------------------------------------------------
  // Lighting + grade (all in linear light)
  // ---------------------------------------------------------
  vec3 hiLin = srgb2lin(u_colorHighlight);

  color *= u_ambient + (1.0 - u_ambient) * diffuse;

  // The lip of each pooled layer: a dark contour on the shadow side and a
  // glossy catch of light along the ridge itself.
  color *= mix(1.0, 0.45, edge * u_edgeDark);
  color += hiLin * edge * u_edgeGloss * (0.25 + 0.75 * spec);

  color += hiLin * spec;
  color += hiLin * fresnel * 0.10;

  color *= u_exposure;
  color = aces(color);

  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(luma), color, u_satFactor);
  color = (color - 0.5) * u_conFactor + 0.5;

  float vig = 1.0 - u_vignette * pow(length(vUv - 0.5) * 1.35, 2.2);
  color *= clamp(vig, 0.0, 1.0);

  color = lin2srgb(max(color, 0.0));

  // Grain, then a sub-LSB dither to break up banding in the dark falloff.
  float grain = hash1(gl_FragCoord.xy + fract(iTime) * 137.0) - 0.5;
  color += grain * u_grain;
  color += (hash1(gl_FragCoord.xy * 1.7 + 3.3) - 0.5) / 255.0;

  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
