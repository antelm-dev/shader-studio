import { describe, expect, it } from 'vitest';

import { logLevels } from './logger';

describe('logLevels', () => {
  it('enables the named level and everything louder', () => {
    expect(logLevels('warn')).toEqual(['fatal', 'error', 'warn']);
    expect(logLevels('debug')).toEqual(['fatal', 'error', 'warn', 'log', 'debug']);
    expect(logLevels('fatal')).toEqual(['fatal']);
  });

  it('falls back to log for an unset or unknown level', () => {
    expect(logLevels(undefined)).toEqual(['fatal', 'error', 'warn', 'log']);
    expect(logLevels('chatty')).toEqual(logLevels(undefined));
  });
});
