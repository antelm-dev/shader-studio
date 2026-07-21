type LogLevel = 'error' | 'warn' | 'info' | 'debug';

type LogFn = (...args: unknown[]) => void;

export interface Logger {
  error: LogFn;
  warn: LogFn;
  info: LogFn;
  debug: LogFn;
}

const COLORS: Record<LogLevel, number> = {
  error: 31,
  warn: 33,
  info: 32,
  debug: 34,
};
const LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug'];

export function createLogger(label: string, level: LogLevel = 'info'): Logger {
  const threshold = LEVELS.indexOf(level);

  const build = (logLevel: LogLevel): LogFn => {
    if (LEVELS.indexOf(logLevel) > threshold) {
      return () => void 0;
    }

    return (...args: unknown[]) => {
      const timestamp = new Date().toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        hourCycle: 'h23',
      });
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
