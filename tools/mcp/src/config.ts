import { resolveBridgeToken, type ResolvedToken } from './token.js';
import type { LogLevel } from './logger.js';

/**
 * Validates every environment-driven setting once, at startup, instead of
 * letting each module read `process.env` on its own — `main()` calls this
 * exactly once and either gets a fully-checked config back or a
 * `ConfigError` with an actionable message to print to stderr before exiting.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const LOG_LEVELS: readonly LogLevel[] = ['silent', 'error', 'warn', 'info', 'debug'];
const MIN_RECOMMENDED_TOKEN_LENGTH = 16;

export const DEFAULT_PORT = 4310;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

export interface McpServerConfig {
  port: number;
  host: string;
  logLevel: LogLevel;
  token: ResolvedToken;
  /** Non-fatal issues worth surfacing once the logger exists (e.g. a non-loopback host). */
  warnings: readonly string[];
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new ConfigError(
      `Invalid SHADER_STUDIO_MCP_PORT "${raw}": must be an integer between 0 and 65535 ` +
        '(0 lets the OS pick a free port).',
    );
  }
  return value;
}

function parseHost(raw: string | undefined, warnings: string[]): string {
  // Unset or explicitly empty means "use the default." A value that's
  // present but blank (whitespace only) is a configuration mistake, not an
  // unset variable, and must be rejected rather than silently defaulted.
  if (raw === undefined || raw === '') return DEFAULT_HOST;
  if (raw.trim() === '') {
    throw new ConfigError('SHADER_STUDIO_MCP_HOST must not be blank.');
  }
  if (!LOOPBACK_HOSTS.has(raw)) {
    warnings.push(
      `SHADER_STUDIO_MCP_HOST is set to "${raw}", not a loopback address — the bridge will ` +
        'be reachable from beyond this machine. Only do this if you understand the risk.',
    );
  }
  return raw;
}

function parseLogLevel(raw: string | undefined): LogLevel {
  if (raw === undefined || raw.trim() === '') return DEFAULT_LOG_LEVEL;
  if (!LOG_LEVELS.includes(raw as LogLevel)) {
    throw new ConfigError(
      `Invalid SHADER_STUDIO_MCP_LOG_LEVEL "${raw}": must be one of ${LOG_LEVELS.join(', ')}.`,
    );
  }
  return raw as LogLevel;
}

function checkToken(token: ResolvedToken, warnings: string[]): void {
  if (token.source === 'env' && token.value.length < MIN_RECOMMENDED_TOKEN_LENGTH) {
    warnings.push(
      `SHADER_STUDIO_MCP_TOKEN is shorter than ${MIN_RECOMMENDED_TOKEN_LENGTH} characters; ` +
        'consider a longer, high-entropy token.',
    );
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpServerConfig {
  const warnings: string[] = [];

  const port = parsePort(env['SHADER_STUDIO_MCP_PORT']);
  const host = parseHost(env['SHADER_STUDIO_MCP_HOST'], warnings);
  const logLevel = parseLogLevel(env['SHADER_STUDIO_MCP_LOG_LEVEL']);
  const token = resolveBridgeToken(env);
  checkToken(token, warnings);

  return { port, host, logLevel, token, warnings };
}
