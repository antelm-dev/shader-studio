const COLORS = {
  error: 31,
  warn: 33,
  info: 32,
  debug: 34,
} as const;

const LEVELS = ['error', 'warn', 'info', 'debug'] as const;
type LogLevel = (typeof LEVELS)[number];

/** Minimal logging surface consumed by the runner. */
export interface LoggerLike {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

/**
 * Create a labelled console logger. Levels at or above `level` are emitted;
 * quieter levels become no-ops.
 */
export function createLogger(label: string, level: LogLevel = 'info'): LoggerLike {
  const threshold = LEVELS.indexOf(level);

  const build = (logLevel: LogLevel) => {
    if (LEVELS.indexOf(logLevel) > threshold) {
      return () => void 0;
    }

    return (...args: unknown[]) => {
      const timestamp = new Date().toLocaleTimeString();
      console[logLevel](`\x1b[${COLORS[logLevel]}m${timestamp} [${label}]\x1b[0m`, ...args);
    };
  };

  return {
    error: build('error'),
    warn: build('warn'),
    info: build('info'),
    debug: build('debug'),
  };
}
