const BUILT_INS: readonly [string, string][] = [
  ['iResolution', 'uniform vec2 iResolution;'],
  ['iTime', 'uniform float iTime;'],
  ['iMouse', 'uniform vec4 iMouse;'],
  ['iChannel0', 'uniform sampler2D iChannel0;'],
  ['iChannel1', 'uniform sampler2D iChannel1;'],
  ['iChannel2', 'uniform sampler2D iChannel2;'],
  ['iChannel3', 'uniform sampler2D iChannel3;'],
];

export interface ShadertoyImport {
  fragment: string;
  warnings: string[];
}

/** Convert a Shadertoy Image pass into Shader Studio's WebGL 1 fragment format. */
export function convertShadertoy(source: string): ShadertoyImport {
  let fragment = source.trim().replace(/\\\*/g, '*');
  if (!/\bvoid\s+mainImage\s*\(/.test(fragment)) {
    throw new Error('No mainImage function found. Paste the code from a Shadertoy Image pass.');
  }

  const warnings: string[] = [];
  if (/\biChannel[0-3]\b/.test(fragment)) {
    warnings.push('Assign the referenced iChannel textures in the Textures panel after importing.');
  }
  if (
    /\biFrame\b|\biFrameRate\b|\biDate\b|\biChannelTime\b|\biChannelResolution\b/.test(fragment)
  ) {
    warnings.push('Some Shadertoy uniforms are not provided and may need manual edits.');
  }

  const declarations: string[] = [];
  if (!/^\s*precision\s+(?:lowp|mediump|highp)\s+float\s*;/m.test(fragment)) {
    declarations.push('precision highp float;');
  }
  for (const [name, declaration] of BUILT_INS) {
    if (
      new RegExp(`\\b${name}\\b`).test(fragment) &&
      !new RegExp(`\\buniform\\s+(?:lowp\\s+|mediump\\s+|highp\\s+)?\\w+\\s+${name}\\b`).test(
        fragment,
      )
    ) {
      declarations.push(declaration);
    }
  }

  fragment = `${declarations.join('\n')}${declarations.length ? '\n\n' : ''}${fragment}\n\nvoid main() {\n  vec4 shadertoyColor = vec4(0.0);\n  mainImage(shadertoyColor, gl_FragCoord.xy);\n  gl_FragColor = shadertoyColor;\n}\n`;
  return { fragment, warnings };
}
