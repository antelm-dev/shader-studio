import { describe, expect, it } from 'vitest';

import { convertShadertoy } from './shadertoy-import';

describe('convertShadertoy', () => {
  it('adds used built-ins and a WebGL main function', () => {
    const result = convertShadertoy(`
      void mainImage(out vec4 fragColor, in vec2 fragCoord) {
        fragColor = vec4(fragCoord / iResolution.xy, sin(iTime), 1.0);
      }
    `);
    expect(result.fragment).toContain('precision highp float;');
    expect(result.fragment).toContain('uniform vec2 iResolution;');
    expect(result.fragment).toContain('uniform float iTime;');
    expect(result.fragment).toContain('mainImage(shadertoyColor, gl_FragCoord.xy);');
  });

  it('does not duplicate declarations and repairs escaped multiplication', () => {
    const result = convertShadertoy(`
      precision mediump float;
      uniform float iTime;
      void mainImage(out vec4 c, in vec2 p) { c = vec4(iTime \\* p.x); }
    `);
    expect(result.fragment.match(/uniform float iTime;/g)).toHaveLength(1);
    expect(result.fragment).toContain('iTime * p.x');
  });

  it('declares texture channels used by the source', () => {
    const result = convertShadertoy(`
      void mainImage(out vec4 c, in vec2 p) { c = texture2D(iChannel0, p); }
    `);
    expect(result.fragment).toContain('uniform sampler2D iChannel0;');
    expect(result.warnings).toHaveLength(1);
  });

  it('rejects source without an Image entry point', () => {
    expect(() => convertShadertoy('void main() {}')).toThrow(/mainImage/);
  });
});
