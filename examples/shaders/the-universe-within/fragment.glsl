precision highp float;

uniform vec2 iResolution;
uniform float iTime;
uniform vec4 iMouse;

uniform float u_timeScale;
uniform float u_layers;
uniform float u_gridNear;
uniform float u_gridFar;
uniform float u_cellJitter;
uniform float u_lineWidth;
uniform float u_sparkle;
uniform float u_pulseRate;
uniform float u_mouseStrength;
uniform bool u_steering;
uniform bool u_autoHue;
uniform vec3 u_colorA;
uniform vec3 u_colorB;
uniform float u_glow;
uniform float u_exposure;
uniform float u_vignette;

varying vec2 vUv;

float N21(vec2 p) {
  vec3 a = fract(vec3(p.xyx) * vec3(213.897, 653.453, 253.098));
  a += dot(a, a.yzx + 79.76);
  return fract((a.x + a.y) * a.z);
}

vec2 GetPos(vec2 id, vec2 offs, float t) {
  float n = N21(id + offs);
  float n1 = fract(n * 10.0);
  float n2 = fract(n * 100.0);
  float a = t + n;
  return offs + vec2(sin(a * n1), cos(a * n2)) * u_cellJitter;
}

float df_line(vec2 a, vec2 b, vec2 p) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

float line(vec2 a, vec2 b, vec2 uv) {
  float r1 = u_lineWidth;
  float r2 = u_lineWidth * 0.25;
  float d = df_line(a, b, uv);
  float d2 = length(a - b);
  float fade = smoothstep(1.5, 0.5, d2);
  fade += smoothstep(0.05, 0.02, abs(d2 - 0.75));
  return smoothstep(r1, r2, d) * fade;
}

float NetLayer(vec2 st, float n, float t) {
  vec2 id = floor(st) + n;
  st = fract(st) - 0.5;

  vec2 p[9];
  int i = 0;
  for (float y = -1.0; y <= 1.0; y++) {
    for (float x = -1.0; x <= 1.0; x++) {
      p[i++] = GetPos(id, vec2(x, y), t);
    }
  }

  float m = 0.0;
  float sparkle = 0.0;

  for (int j = 0; j < 9; j++) {
    m += line(p[4], p[j], st);

    float d = length(st - p[j]);
    float s = 0.005 / (d * d + 1e-4);
    s *= smoothstep(1.0, 0.7, d);
    float pulse = sin((fract(p[j].x) + fract(p[j].y) + t) * u_pulseRate) * 0.4 + 0.6;
    pulse = pow(pulse, 20.0);
    s *= pulse;
    sparkle += s;
  }

  m += line(p[1], p[3], st);
  m += line(p[1], p[5], st);
  m += line(p[7], p[5], st);
  m += line(p[7], p[3], st);

  float sPhase = (sin(t + n) + sin(t * 0.1)) * 0.25 + 0.5;
  sPhase += pow(sin(t * 0.1) * 0.5 + 0.5, 50.0) * 5.0;
  m += sparkle * sPhase * u_sparkle;

  return m;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * iResolution.xy) / iResolution.y;
  vec2 M = vec2(0.0);
  if (u_steering) {
    bool pointerActive =
      iMouse.x >= 0.0 &&
      iMouse.x <= iResolution.x &&
      iMouse.y >= 0.0 &&
      iMouse.y <= iResolution.y;
    if (pointerActive) {
      M = (iMouse.xy - 0.5 * iResolution.xy) / iResolution.y;
    }
  }

  float t = iTime * u_timeScale;
  float s = sin(t);
  float c = cos(t);
  mat2 rot = mat2(c, -s, s, c);
  vec2 st = uv * rot;
  M *= rot * u_mouseStrength;

  float layers = clamp(floor(u_layers + 0.5), 1.0, 8.0);
  float m = 0.0;

  for (float i = 0.0; i < 8.0; i++) {
    if (i >= layers) break;
    float fi = i / layers;
    float z = fract(t + fi);
    float size = mix(u_gridNear, u_gridFar, z);
    float fade = smoothstep(0.0, 0.6, z) * smoothstep(1.0, 0.8, z);
    m += fade * NetLayer(st * size - M * z, fi, iTime);
  }

  float fft = sin(iTime * 2.0) * 0.1 + 0.1;
  float glow = -uv.y * fft * 2.0 * u_glow;

  vec3 baseCol;
  if (u_autoHue) {
    baseCol = vec3(s, cos(t * 0.4), -sin(t * 0.24)) * 0.4 + 0.6;
    baseCol = mix(u_colorA, baseCol, 0.65);
    baseCol = mix(baseCol, u_colorB, 0.35 + 0.15 * s);
  } else {
    baseCol = mix(u_colorA, u_colorB, 0.5 + 0.5 * s);
  }

  vec3 col = baseCol * m;
  col += baseCol * glow;
  col *= 1.0 - dot(uv, uv);
  col *= u_exposure;

  float vig = 1.0 - u_vignette * pow(length(vUv - 0.5) * 1.4, 2.2);
  col *= clamp(vig, 0.0, 1.0);

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
