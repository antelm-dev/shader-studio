const COLORS = {
  error: 31,
  warn: 33,
  info: 32,
  debug: 34,
};
const LEVELS = ['error', 'warn', 'info', 'debug'];

export function createLogger(label, level = 'info') {
  const threshold = LEVELS.indexOf(level);

  const build = (logLevel) => {
    if (LEVELS.indexOf(logLevel) > threshold) {
      return () => void 0;
    }

    return (...args) => {
      const timestamp = new Date().toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        hourCycle: 'h23',
      });
      console[logLevel](
        `\x1b[${COLORS[logLevel]}m${timestamp} [${label}]\x1b[0m`,
        ...args,
      );
    };
  };

  return {
    error: build('error'),
    warn: build('warn'),
    info: build('info'),
    debug: build('debug'),
  };
}
