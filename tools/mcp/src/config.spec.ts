import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigError, DEFAULT_HOST, DEFAULT_LOG_LEVEL, DEFAULT_PORT, loadConfig } from './config';
import { resetBridgeTokenForTests } from './token';

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { ...overrides };
}

describe('loadConfig', () => {
  beforeEach(() => resetBridgeTokenForTests());
  afterEach(() => resetBridgeTokenForTests());

  it('defaults the port to 4310', () => {
    const config = loadConfig(env());
    expect(config.port).toBe(DEFAULT_PORT);
  });

  it('honors an overridden port', () => {
    const config = loadConfig(env({ SHADER_STUDIO_MCP_PORT: '5555' }));
    expect(config.port).toBe(5555);
  });

  it('allows port 0 (OS-assigned, used by tests)', () => {
    const config = loadConfig(env({ SHADER_STUDIO_MCP_PORT: '0' }));
    expect(config.port).toBe(0);
  });

  it.each(['-1', '65536', 'not-a-number', '3.5'])('rejects an invalid port %s', (raw) => {
    expect(() => loadConfig(env({ SHADER_STUDIO_MCP_PORT: raw }))).toThrow(ConfigError);
  });

  it('defaults the host to 127.0.0.1', () => {
    const config = loadConfig(env());
    expect(config.host).toBe(DEFAULT_HOST);
    expect(config.warnings).toHaveLength(0);
  });

  it('rejects a blank host', () => {
    expect(() => loadConfig(env({ SHADER_STUDIO_MCP_HOST: '   ' }))).toThrow(ConfigError);
  });

  it('allows a non-loopback host but warns about it', () => {
    const config = loadConfig(env({ SHADER_STUDIO_MCP_HOST: '0.0.0.0' }));
    expect(config.host).toBe('0.0.0.0');
    expect(config.warnings.some((w) => w.includes('0.0.0.0'))).toBe(true);
  });

  it('defaults the log level to info', () => {
    const config = loadConfig(env());
    expect(config.logLevel).toBe(DEFAULT_LOG_LEVEL);
  });

  it.each(['silent', 'error', 'warn', 'info', 'debug'])('accepts log level %s', (level) => {
    const config = loadConfig(env({ SHADER_STUDIO_MCP_LOG_LEVEL: level }));
    expect(config.logLevel).toBe(level);
  });

  it('rejects an invalid log level', () => {
    expect(() => loadConfig(env({ SHADER_STUDIO_MCP_LOG_LEVEL: 'verbose' }))).toThrow(ConfigError);
  });

  it('generates a token when none is configured', () => {
    const config = loadConfig(env());
    expect(config.token.source).toBe('generated');
    expect(config.token.value.length).toBeGreaterThan(0);
  });

  it('uses the configured token when SHADER_STUDIO_MCP_TOKEN is set', () => {
    const config = loadConfig(env({ SHADER_STUDIO_MCP_TOKEN: 'a-long-enough-token-value' }));
    expect(config.token).toMatchObject({ source: 'env', value: 'a-long-enough-token-value' });
  });

  it('warns about a short configured token without rejecting it', () => {
    const config = loadConfig(env({ SHADER_STUDIO_MCP_TOKEN: 'short' }));
    expect(config.token.source).toBe('env');
    expect(config.warnings.some((w) => w.includes('SHADER_STUDIO_MCP_TOKEN'))).toBe(true);
  });

  it('treats an empty SHADER_STUDIO_MCP_TOKEN as unset', () => {
    const config = loadConfig(env({ SHADER_STUDIO_MCP_TOKEN: '' }));
    expect(config.token.source).toBe('generated');
  });
});
