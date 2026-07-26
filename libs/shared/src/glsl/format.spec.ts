import { describe, expect, it } from 'vitest';

import { formatGlsl } from './format';

const options = { tabSize: 2 };

describe('formatGlsl', () => {
  it('re-indents by block depth', () => {
    const source = `void main() {
vec3 color = vec3(0.0);
if (u_on) {
color = vec3(1.0);
}
gl_FragColor = vec4(color, 1.0);
}`;

    expect(formatGlsl(source, options)).toBe(`void main() {
  vec3 color = vec3(0.0);
  if (u_on) {
    color = vec3(1.0);
  }
  gl_FragColor = vec4(color, 1.0);
}
`);
  });

  it('puts a closing brace under its opener, else included', () => {
    const source = `void main() {
    if (a) {
        x = 1.0;
        } else {
    x = 2.0;
        }
}`;

    expect(formatGlsl(source, options)).toBe(`void main() {
  if (a) {
    x = 1.0;
  } else {
    x = 2.0;
  }
}
`);
  });

  it('honours the tab size, and tabs when asked', () => {
    const source = 'void main() {\nx = 1.0;\n}';

    expect(formatGlsl(source, { tabSize: 4 })).toContain('    x = 1.0;');
    expect(formatGlsl(source, { tabSize: 2, insertSpaces: false })).toContain('\tx = 1.0;');
  });

  it('never counts a brace that is only part of a comment', () => {
    const source = `void main() {
// a stray { in a line comment
/* and a } in a block one */
x = 1.0;
}`;

    expect(formatGlsl(source, options)).toBe(`void main() {
  // a stray { in a line comment
  /* and a } in a block one */
  x = 1.0;
}
`);
  });

  it('leaves the inside of a block comment exactly as authored', () => {
    const source = `/**
 * A diagram:
 *     +---+
 */
void main() {}`;

    expect(formatGlsl(source, options)).toBe(`/**
 * A diagram:
 *     +---+
 */
void main() {}
`);
  });

  it('keeps preprocessor directives at column zero', () => {
    const source = `void main() {
#ifdef HIGH
x = 1.0;
#endif
}`;

    expect(formatGlsl(source, options)).toBe(`void main() {
#ifdef HIGH
  x = 1.0;
#endif
}
`);
  });

  it('trims trailing whitespace and ends with exactly one newline', () => {
    expect(formatGlsl('void main() {}   \n\n\n', options)).toBe('void main() {}\n');
  });

  it('preserves blank lines between blocks', () => {
    const source = 'float a = 1.0;\n\nvoid main() {\nx = a;\n}';

    expect(formatGlsl(source, options)).toBe('float a = 1.0;\n\nvoid main() {\n  x = a;\n}\n');
  });

  it('does not go negative on unbalanced closing braces', () => {
    expect(formatGlsl('}\n}\nfloat a = 1.0;', options)).toBe('}\n}\nfloat a = 1.0;\n');
  });

  it('is idempotent', () => {
    const source = `precision highp float;

uniform float iTime;

void main() {
  float t = iTime;
  if (t > 1.0) {
    t = 1.0;
  }
  gl_FragColor = vec4(t);
}
`;

    expect(formatGlsl(formatGlsl(source, options), options)).toBe(formatGlsl(source, options));
    expect(formatGlsl(source, options)).toBe(source);
  });
});
