import type { CompileDiagnostic } from '../core/diagnostic';

/**
 * Turn a driver's shader info log into diagnostics the editor can point at.
 *
 * Two log dialects cover every browser we care about:
 *
 *   ANGLE / desktop GL:  ERROR: 0:42: 'foo' : undeclared identifier
 *   Mesa:                0:42(13): error: syntax error
 *
 * The line numbers count from the top of the source the driver was handed,
 * which is not the source the user typed: three.js prepends a prelude of
 * defines and precision qualifiers. `offset` is how many lines that prelude
 * takes, and it is subtracted here so a diagnostic lands on the line the user
 * is actually looking at.
 */

const ANGLE_PATTERN = /^\s*(ERROR|WARNING)\s*:\s*(\d+)\s*:\s*(\d+)\s*:\s*(.*)$/i;
const MESA_PATTERN = /^\s*(\d+):(\d+)\(\d+\)\s*:\s*(error|warning)\s*:\s*(.*)$/i;

export function parseInfoLog(
  log: string,
  source: 'fragment' | 'vertex',
  offset = 0,
): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];

  for (const raw of log.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    const angle = ANGLE_PATTERN.exec(line);
    if (angle) {
      diagnostics.push({
        severity: angle[1].toUpperCase() === 'WARNING' ? 'warning' : 'error',
        line: Math.max(1, Number(angle[3]) - offset),
        message: angle[4].trim(),
        source,
      });
      continue;
    }

    const mesa = MESA_PATTERN.exec(line);
    if (mesa) {
      diagnostics.push({
        severity: mesa[3].toLowerCase() === 'warning' ? 'warning' : 'error',
        line: Math.max(1, Number(mesa[2]) - offset),
        message: mesa[4].trim(),
        source,
      });
      continue;
    }

    // Anything unrecognised is still worth surfacing — a link error, say — but
    // it has no line to anchor to.
    if (/error/i.test(line)) {
      diagnostics.push({ severity: 'error', line: 0, message: line, source });
    }
  }

  return diagnostics;
}

/**
 * How many lines the compiler saw before the user's first line.
 *
 * Rather than trying to predict three.js's prelude, find the user's source
 * inside the source the driver was actually given and count the newlines in
 * front of it. That stays correct across three.js versions.
 */
export function prefixLineCount(fullSource: string, userSource: string): number {
  // The first line is enough to locate the block, and unlike the whole body it
  // survives any normalisation three.js might have done further down.
  const anchor = userSource.slice(0, 200);
  const index = fullSource.indexOf(anchor);
  if (index <= 0) return 0;
  return fullSource.slice(0, index).split('\n').length - 1;
}
