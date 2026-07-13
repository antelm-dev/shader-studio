/**
 * Turning a shader in the editor into GLSL you can compile somewhere else.
 *
 * A shader in the studio is only half a source file: the engine hands it a set
 * of uniforms, and the control schema decides what the rest of them are called.
 * A fragment lifted out of the editor and pasted into another engine is
 * therefore missing every declaration that made it work here — which is what
 * `buildFullGlsl` puts back.
 *
 * Nothing here touches the DOM or three.js: it is a string in, a string out, so
 * the engine can share the macro expansion with it and the tests can read it.
 */

import { MAX_WAVES, UNIFORM_PREFIX, type ShaderControl } from './model';

/** Substitutions the engine makes in every shader before compiling it. */
export function expandMacros(source: string): string {
  return source.replaceAll('__MAX_WAVES__', String(MAX_WAVES));
}

/** The GLSL type of the uniform a control drives. */
export function uniformType(control: ShaderControl): string {
  switch (control.type) {
    case 'boolean':
      return 'bool';
    case 'color':
      return 'vec3';
    // A select is a dropdown over numbers, so it arrives as one.
    case 'number':
    case 'select':
      return 'float';
  }
}

interface Declaration {
  /** The identifier, which is also what we search the source for. */
  name: string;
  line: string;
}

const BUILT_INS: readonly Declaration[] = [
  { name: 'iTime', line: 'uniform float iTime;' },
  { name: 'iResolution', line: 'uniform vec2 iResolution;' },
  { name: 'iMouse', line: 'uniform vec4 iMouse;' },
  { name: 'iMouseVel', line: 'uniform vec2 iMouseVel;' },
  { name: 'u_clickData', line: `uniform vec3 u_clickData[${MAX_WAVES}];` },
  { name: 'iChannel0', line: 'uniform sampler2D iChannel0;' },
  { name: 'iChannel1', line: 'uniform sampler2D iChannel1;' },
  { name: 'iChannel2', line: 'uniform sampler2D iChannel2;' },
  { name: 'iChannel3', line: 'uniform sampler2D iChannel3;' },
];

/** True if `source` already declares `name` as a uniform or a varying. */
function declares(source: string, name: string): boolean {
  return new RegExp(`\\b(?:uniform|varying|attribute)\\b[^;]*\\b${name}\\b`).test(source);
}

/** True if `name` appears anywhere in `source` as a whole word. */
function mentions(source: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(source);
}

function declarationsFor(controls: readonly ShaderControl[]): Declaration[] {
  return controls.map((control) => {
    const name = UNIFORM_PREFIX + control.key;
    return { name, line: `uniform ${uniformType(control)} ${name};` };
  });
}

/**
 * The fragment source with everything it needs to stand on its own: the
 * precision qualifier, the engine's uniforms, one uniform per control, and the
 * varying the default vertex shader hands over.
 *
 * Only what is *missing* is generated. A shader that already declares `iTime`
 * keeps its own line — emitting a second one would be a redeclaration error,
 * which is precisely the kind of thing you do not want to discover in the
 * engine you pasted this into.
 *
 * Declarations for uniforms the source never mentions are emitted anyway, since
 * the point is a file that carries the whole contract. `vUv` is the exception:
 * it belongs to the vertex shader, so it only appears if the fragment uses it.
 */
export function buildFullGlsl(fragment: string, controls: readonly ShaderControl[]): string {
  const source = expandMacros(fragment);
  const sections: string[] = [];

  if (!/^\s*precision\s+\w+\s+float\s*;/m.test(source)) {
    sections.push('precision highp float;');
  }

  const builtIns = BUILT_INS.filter((entry) => !declares(source, entry.name));
  if (builtIns.length > 0) {
    sections.push(
      ['// Provided by the engine for every shader.', ...builtIns.map((entry) => entry.line)].join(
        '\n',
      ),
    );
  }

  const fromControls = declarationsFor(controls).filter((entry) => !declares(source, entry.name));
  if (fromControls.length > 0) {
    sections.push(
      [
        '// One uniform per control in the schema, named u_<key>.',
        ...fromControls.map((entry) => entry.line),
      ].join('\n'),
    );
  }

  if (mentions(source, 'vUv') && !declares(source, 'vUv')) {
    sections.push('varying vec2 vUv;');
  }

  if (sections.length === 0) return source;
  return `${sections.join('\n\n')}\n\n${source.trimStart()}`;
}
