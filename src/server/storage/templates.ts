import type { ShaderControl } from '../../shared/model';

export const DEFAULT_VERTEX = `varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const TEMPLATE_CONTROLS: ShaderControl[] = [
  {
    key: 'timeScale',
    type: 'number',
    label: 'Time Scale',
    folder: 'Motion',
    default: 0.4,
    min: 0,
    max: 2,
  },
  {
    key: 'scale',
    type: 'number',
    label: 'Scale',
    folder: 'Structure',
    default: 3,
    min: 0.5,
    max: 12,
  },
  { key: 'colorA', type: 'color', label: 'Color A', folder: 'Palette', default: '#1b2a4a' },
  { key: 'colorB', type: 'color', label: 'Color B', folder: 'Palette', default: '#5ad1c8' },
];

export const TEMPLATE_FRAGMENT = `precision highp float;

// Built-in uniforms, always provided by the engine.
uniform vec2 iResolution;
uniform float iTime;

// One uniform per control in the schema, named u_<key>.
uniform float u_timeScale;
uniform float u_scale;
uniform vec3 u_colorA;
uniform vec3 u_colorB;

varying vec2 vUv;

void main() {
  vec2 uv = vUv;
  uv.x *= iResolution.x / iResolution.y;

  float t = iTime * u_timeScale;
  float wave = sin(uv.x * u_scale + t) * 0.5 + 0.5;
  wave *= sin(uv.y * u_scale - t * 0.7) * 0.5 + 0.5;

  vec3 color = mix(u_colorA, u_colorB, wave);
  gl_FragColor = vec4(color, 1.0);
}
`;
