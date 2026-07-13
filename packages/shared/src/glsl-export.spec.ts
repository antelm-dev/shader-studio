import { describe, expect, it } from 'vitest';

import { MAX_WAVES, type ShaderControl } from '@shader-studio/shared/model';
import { buildFullGlsl, expandMacros, uniformType } from './glsl-export';

const CONTROLS: ShaderControl[] = [
  { key: 'scale', type: 'number', default: 3, min: 0.5, max: 12 },
  { key: 'wireframe', type: 'boolean', default: false },
  { key: 'tint', type: 'color', default: '#5ad1c8' },
  { key: 'mode', type: 'select', default: 1, options: { Soft: 1, Hard: 2 } },
];

describe('expandMacros', () => {
  it('substitutes the ripple slot count', () => {
    expect(expandMacros('uniform vec3 u_clickData[__MAX_WAVES__];')).toBe(
      `uniform vec3 u_clickData[${MAX_WAVES}];`,
    );
  });
});

describe('uniformType', () => {
  it('maps every control type onto its GLSL type', () => {
    expect(CONTROLS.map(uniformType)).toEqual(['float', 'bool', 'vec3', 'float']);
  });
});

describe('buildFullGlsl', () => {
  it('declares one uniform per control, named u_<key>', () => {
    const glsl = buildFullGlsl('void main() { gl_FragColor = vec4(u_tint, 1.0); }', CONTROLS);

    expect(glsl).toContain('uniform float u_scale;');
    expect(glsl).toContain('uniform bool u_wireframe;');
    expect(glsl).toContain('uniform vec3 u_tint;');
    expect(glsl).toContain('uniform float u_mode;');
  });

  it('declares the engine uniforms, with the ripple array already expanded', () => {
    const glsl = buildFullGlsl('void main() {}', []);

    expect(glsl).toContain('uniform float iTime;');
    expect(glsl).toContain('uniform vec2 iResolution;');
    expect(glsl).toContain('uniform vec4 iMouse;');
    expect(glsl).toContain('uniform vec2 iMouseVel;');
    expect(glsl).toContain(`uniform vec3 u_clickData[${MAX_WAVES}];`);
    expect(glsl).toContain('uniform sampler2D iChannel3;');
    expect(glsl).not.toContain('__MAX_WAVES__');
  });

  it('keeps the source and appends nothing it already declares', () => {
    const source = `precision mediump float;
uniform float iTime;
uniform float u_scale;

void main() { gl_FragColor = vec4(u_scale * iTime); }`;

    const glsl = buildFullGlsl(source, [CONTROLS[0]]);

    // Redeclaring either of these would be a compile error in the engine the
    // user pastes this into, which is the whole reason the generator looks.
    expect(glsl.match(/uniform float iTime;/g)).toHaveLength(1);
    expect(glsl.match(/uniform float u_scale;/g)).toHaveLength(1);
    expect(glsl).toContain('precision mediump float;');
    expect(glsl).not.toContain('precision highp float;');
    expect(glsl).toContain('void main() { gl_FragColor = vec4(u_scale * iTime); }');
  });

  it('adds a precision qualifier only when the source has none', () => {
    expect(buildFullGlsl('void main() {}', [])).toMatch(/^precision highp float;/);
  });

  it('declares vUv when the fragment uses it, and not otherwise', () => {
    expect(buildFullGlsl('void main() { gl_FragColor = vec4(vUv, 0.0, 1.0); }', [])).toContain(
      'varying vec2 vUv;',
    );
    expect(buildFullGlsl('void main() {}', [])).not.toContain('varying vec2 vUv;');
  });

  it('returns the source untouched when nothing is missing', () => {
    const source = [
      'precision highp float;',
      'uniform float iTime;',
      'uniform vec2 iResolution;',
      'uniform vec4 iMouse;',
      'uniform vec2 iMouseVel;',
      'uniform vec3 u_clickData[24];',
      'uniform sampler2D iChannel0;',
      'uniform sampler2D iChannel1;',
      'uniform sampler2D iChannel2;',
      'uniform sampler2D iChannel3;',
      '',
      'void main() { gl_FragColor = vec4(iTime); }',
    ].join('\n');

    expect(buildFullGlsl(source, [])).toBe(source);
  });
});
