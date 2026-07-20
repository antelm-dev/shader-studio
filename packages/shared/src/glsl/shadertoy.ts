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

export interface WrapMainImageOptions {
  /**
   * Whether to warn about `iChannel0-3` needing manual assignment. The
   * paste-one-pass flow can't know if they'll ever be wired, so it always
   * warns; the Shadertoy API importer wires them itself and passes `false`.
   */
  warnUnassignedChannels?: boolean;
}

/**
 * Wraps a Shadertoy `mainImage`-style source (used by the Image pass and every
 * buffer pass) into a WebGL 1 fragment shader: declares whichever built-ins it
 * references but doesn't already declare itself, then calls `mainImage` from a
 * synthesized `main()`. Shared by the paste-one-pass flow and the Shadertoy API
 * importer, which both produce this same shape per pass.
 */
export function wrapMainImage(source: string, options: WrapMainImageOptions = {}): ShadertoyImport {
  const { warnUnassignedChannels = true } = options;
  let fragment = source.trim().replace(/\\\*/g, '*');
  if (!/\bvoid\s+mainImage\s*\(/.test(fragment)) {
    throw new Error('No mainImage function found. Paste the code from a Shadertoy Image pass.');
  }

  const warnings: string[] = [];
  if (warnUnassignedChannels && /\biChannel[0-3]\b/.test(fragment)) {
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

/** Convert a Shadertoy Image pass into Shader Studio's WebGL 1 fragment format. */
export function convertShadertoy(source: string): ShadertoyImport {
  return wrapMainImage(source);
}
