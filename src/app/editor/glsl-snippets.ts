/**
 * The snippets offered in the GLSL editor.
 *
 * Chosen for what this engine actually gives you and what you would otherwise
 * be looking up: the shape of a fragment entry point, aspect-corrected UVs, the
 * `u_clickData` ripple loop nobody remembers the indexing of, and the handful of
 * noise and palette helpers every shader ends up pasting from somewhere.
 *
 * `body` is Monaco snippet syntax: `${1:name}` is a tab stop with a placeholder,
 * `$0` is where the cursor ends up.
 */

export interface GlslSnippet {
  /** What you type to reach it. */
  label: string;
  /** The one-liner shown beside the label in the suggestion list. */
  detail: string;
  body: string;
}

export const GLSL_SNIPPETS: readonly GlslSnippet[] = [
  {
    label: 'main',
    detail: 'Fragment entry point, with aspect-corrected UVs',
    body: [
      'void main() {',
      '  vec2 uv = gl_FragCoord.xy / iResolution.xy;',
      '  uv.x *= iResolution.x / iResolution.y;',
      '',
      '  vec3 color = ${1:vec3(uv, 0.5)};',
      '  gl_FragColor = vec4(color, 1.0);',
      '  $0',
      '}',
    ].join('\n'),
  },
  {
    label: 'uv',
    detail: 'Centred, aspect-corrected UVs',
    body: ['vec2 uv = (gl_FragCoord.xy - 0.5 * iResolution.xy) / iResolution.y;', '$0'].join('\n'),
  },
  {
    label: 'ripple',
    detail: 'Walk u_clickData: every click still in flight',
    body: [
      '// xy: where the click landed, in pixels. z: when, in iTime seconds.',
      'float wave = 0.0;',
      'for (int i = 0; i < __MAX_WAVES__; i++) {',
      '  vec3 click = u_clickData[i];',
      '  if (click.z <= 0.0) continue;',
      '',
      '  float age = iTime - click.z;',
      '  if (age > ${1:2.0}) continue;',
      '',
      '  float distance = length(gl_FragCoord.xy - click.xy);',
      '  float front = age * ${2:220.0};',
      '  wave += smoothstep(${3:24.0}, 0.0, abs(distance - front)) * (1.0 - age / ${1:2.0});',
      '}',
      '$0',
    ].join('\n'),
  },
  {
    label: 'channel',
    detail: 'Sample a texture channel',
    body: 'vec4 ${1:tex} = texture2D(iChannel${2:0}, ${3:uv});\n$0',
  },
  {
    label: 'palette',
    detail: 'Cosine palette (Iñigo Quílez)',
    body: [
      'vec3 palette(float t, vec3 a, vec3 b, vec3 c, vec3 d) {',
      '  return a + b * cos(6.28318 * (c * t + d));',
      '}',
      '$0',
    ].join('\n'),
  },
  {
    label: 'hash21',
    detail: 'vec2 -> float hash',
    body: [
      'float hash21(vec2 p) {',
      '  p = fract(p * vec2(123.34, 456.21));',
      '  p += dot(p, p + 45.32);',
      '  return fract(p.x * p.y);',
      '}',
      '$0',
    ].join('\n'),
  },
  {
    label: 'noise',
    detail: 'Value noise over a 2D lattice',
    body: [
      'float noise(vec2 p) {',
      '  vec2 cell = floor(p);',
      '  vec2 offset = fract(p);',
      '  // Smoothstep the interpolant: linear blending makes the lattice visible.',
      '  vec2 blend = offset * offset * (3.0 - 2.0 * offset);',
      '',
      '  float a = hash21(cell);',
      '  float b = hash21(cell + vec2(1.0, 0.0));',
      '  float c = hash21(cell + vec2(0.0, 1.0));',
      '  float d = hash21(cell + vec2(1.0, 1.0));',
      '',
      '  return mix(mix(a, b, blend.x), mix(c, d, blend.x), blend.y);',
      '}',
      '$0',
    ].join('\n'),
  },
  {
    label: 'fbm',
    detail: 'Fractal brownian motion over noise()',
    body: [
      'float fbm(vec2 p) {',
      '  float total = 0.0;',
      '  float amplitude = 0.5;',
      '',
      '  for (int i = 0; i < ${1:5}; i++) {',
      '    total += noise(p) * amplitude;',
      '    p *= 2.0;',
      '    amplitude *= 0.5;',
      '  }',
      '  return total;',
      '}',
      '$0',
    ].join('\n'),
  },
  {
    label: 'rot2',
    detail: '2D rotation matrix',
    body: [
      'mat2 rot2(float angle) {',
      '  float s = sin(angle);',
      '  float c = cos(angle);',
      '  return mat2(c, -s, s, c);',
      '}',
      '$0',
    ].join('\n'),
  },
  {
    label: 'uniform',
    detail: 'Declare a control uniform',
    body: 'uniform ${1|float,bool,vec3|} u_${2:key};\n$0',
  },
];
