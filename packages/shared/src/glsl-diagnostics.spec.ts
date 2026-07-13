import { describe, expect, it } from 'vitest';

import { parseInfoLog, prefixLineCount } from './glsl-diagnostics';

describe('parseInfoLog', () => {
  it('parses the ANGLE / desktop GL dialect', () => {
    const log = `ERROR: 0:42: 'foo' : undeclared identifier
ERROR: 0:43: '=' : dimension mismatch`;

    expect(parseInfoLog(log, 'fragment')).toEqual([
      { severity: 'error', line: 42, message: "'foo' : undeclared identifier", source: 'fragment' },
      { severity: 'error', line: 43, message: "'=' : dimension mismatch", source: 'fragment' },
    ]);
  });

  it('parses the Mesa dialect', () => {
    const log = '0:12(7): error: syntax error, unexpected $end';

    expect(parseInfoLog(log, 'vertex')).toEqual([
      { severity: 'error', line: 12, message: 'syntax error, unexpected $end', source: 'vertex' },
    ]);
  });

  it('distinguishes warnings from errors', () => {
    const log = `WARNING: 0:5: 'x' : unused variable
ERROR: 0:9: 'y' : undeclared identifier`;

    const diagnostics = parseInfoLog(log, 'fragment');
    expect(diagnostics.map((entry) => entry.severity)).toEqual(['warning', 'error']);
  });

  /**
   * The number in the log counts from the top of the source the *driver* saw,
   * which includes three.js's prelude. Subtracting the prelude is what makes a
   * diagnostic land on the line the user is actually looking at.
   */
  it('subtracts the prelude so the line matches the user source', () => {
    const log = "ERROR: 0:52: 'foo' : undeclared identifier";
    expect(parseInfoLog(log, 'fragment', 50)[0].line).toBe(2);
  });

  it('never reports a line before the first one', () => {
    const log = "ERROR: 0:3: 'foo' : undeclared identifier";
    expect(parseInfoLog(log, 'fragment', 50)[0].line).toBe(1);
  });

  it('keeps an unparseable error rather than dropping it', () => {
    const log = 'Program link error: too many uniforms';

    expect(parseInfoLog(log, 'fragment')).toEqual([
      {
        severity: 'error',
        line: 0,
        message: 'Program link error: too many uniforms',
        source: 'fragment',
      },
    ]);
  });

  it('ignores blank lines and noise', () => {
    expect(parseInfoLog('\n\n  \n', 'fragment')).toEqual([]);
    expect(parseInfoLog('Compiled successfully', 'fragment')).toEqual([]);
  });
});

describe('prefixLineCount', () => {
  it('counts the lines three.js prepended', () => {
    const user = 'precision highp float;\nvoid main() {}';
    const full = ['#define FOO', '#define BAR', '', user].join('\n');

    expect(prefixLineCount(full, user)).toBe(3);
  });

  it('is zero when nothing was prepended', () => {
    const user = 'void main() {}';
    expect(prefixLineCount(user, user)).toBe(0);
  });

  it('falls back to zero when the source cannot be located', () => {
    expect(prefixLineCount('something else entirely', 'void main() {}')).toBe(0);
  });
});
