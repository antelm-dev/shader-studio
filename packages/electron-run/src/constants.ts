/** Prefix for the per-process pid tracking files written to `cwd`. */
export const PID_FILE_PREFIX = 'electron-run-';

/** Default entry file resolved against the bundle output directory. */
export const DEFAULT_ENTRY = 'main.js';

/** Default debounce (ms) applied before a rebuild triggers a restart. */
export const DEFAULT_DEBOUNCE_MS = 150;

/** Interactive stdin commands accepted while the runner is attached to a TTY. */
export const COMMANDS = new Set([
  'rs',
  'restart',
  'start',
  'stop',
  'status',
  'clear',
  'cls',
  'help',
] as const);
