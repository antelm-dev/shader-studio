/**
 * A GLSL formatter, deliberately small.
 *
 * It re-indents by block depth, trims trailing whitespace and ends the file
 * with a newline. It does not rewrap, reorder, insert spaces around operators
 * or otherwise have opinions about a line's contents — a shader is dense
 * numeric code whose author aligned those columns on purpose, and a formatter
 * that "fixes" `vec3(0.5, 0.5, 0.5)` into something else is a formatter people
 * turn off.
 *
 * Free of Monaco, so the rules can be read and tested on their own; the editor
 * registers it as GLSL's document formatting provider.
 */

export interface GlslFormatOptions {
  /** Columns per level of indentation. */
  tabSize: number;
  /** Indent with tabs instead of spaces. */
  insertSpaces?: boolean;
}

/**
 * The line with comments removed, so brace counting never trips over a `{` that
 * was only ever part of a sentence.
 *
 * `openBlock` reports a `/*` the line never closed, which is what carries the
 * comment state on to the next one.
 */
function stripComments(line: string): { code: string; openBlock: boolean } {
  let code = '';
  let index = 0;

  while (index < line.length) {
    const rest = line.slice(index);

    if (rest.startsWith('//')) break;

    if (rest.startsWith('/*')) {
      const end = line.indexOf('*/', index + 2);
      if (end === -1) return { code, openBlock: true };
      index = end + 2;
      continue;
    }

    code += line[index];
    index++;
  }

  return { code, openBlock: false };
}

function count(text: string, character: string): number {
  let total = 0;
  for (const item of text) {
    if (item === character) total++;
  }
  return total;
}

/** How many of the braces closing this line's own indent sit at its start. */
function leadingClosers(code: string): number {
  const match = /^[\s})\]]*/.exec(code);
  return match ? count(match[0], '}') : 0;
}

export function formatGlsl(source: string, options: GlslFormatOptions): string {
  const tabSize = Math.min(Math.max(Math.round(options.tabSize) || 2, 1), 8);
  const unit = options.insertSpaces === false ? '\t' : ' '.repeat(tabSize);

  const lines = source.split(/\r?\n/);
  const output: string[] = [];

  let depth = 0;
  let inBlockComment = false;

  for (const raw of lines) {
    // Inside a block comment, only trailing whitespace goes. Whatever the
    // author lined up in there — a diagram, a table of constants — is left
    // exactly where they put it.
    if (inBlockComment) {
      output.push(raw.trimEnd());
      if (raw.includes('*/')) inBlockComment = false;
      continue;
    }

    const trimmed = raw.trim();

    if (trimmed.length === 0) {
      output.push('');
      continue;
    }

    // Preprocessor directives are column-zero constructs; some drivers still
    // insist on it, and every GLSL author expects to see them there.
    if (trimmed.startsWith('#')) {
      output.push(trimmed);
      const { openBlock } = stripComments(trimmed);
      inBlockComment = openBlock;
      continue;
    }

    const { code, openBlock } = stripComments(trimmed);

    // A line that starts by closing its block belongs one level out — which is
    // what puts `}` under its `if`, and keeps `} else {` there too.
    const indent = Math.max(0, depth - leadingClosers(code));
    output.push(unit.repeat(indent) + trimmed);

    depth = Math.max(0, depth + count(code, '{') - count(code, '}'));
    inBlockComment = openBlock;
  }

  // Trailing blank lines are noise; a single final newline is not.
  while (output.length > 0 && output[output.length - 1] === '') output.pop();

  return output.length === 0 ? '' : `${output.join('\n')}\n`;
}
