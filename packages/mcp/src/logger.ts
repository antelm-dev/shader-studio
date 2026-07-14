/**
 * The one place in this package allowed to write operational output. MCP
 * protocol messages travel over stdin/stdout (owned by the SDK's
 * `StdioServerTransport`); every log, banner, and diagnostic here goes to
 * stderr instead, so a client tailing stdout never sees anything but
 * JSON-RPC frames.
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_RANK: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export interface Logger {
  readonly level: LogLevel;
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
}

function write(message: string): void {
  process.stderr.write(`[shader-studio-mcp] ${message}\n`);
}

export function createLogger(level: LogLevel): Logger {
  const enabled = (target: LogLevel) => LEVEL_RANK[level] >= LEVEL_RANK[target];

  return {
    level,
    error: (message) => enabled('error') && write(message),
    warn: (message) => enabled('warn') && write(message),
    info: (message) => enabled('info') && write(message),
    debug: (message) => enabled('debug') && write(message),
  };
}
