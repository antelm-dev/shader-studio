import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger.js';

describe('createLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits levels at or above the threshold', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const logger = createLogger('test', 'info');
    logger.info('hello');
    logger.warn('careful');
    logger.error('boom');

    expect(info).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
  });

  it('suppresses levels below the threshold', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const logger = createLogger('test', 'warn');
    logger.debug('noisy');
    logger.info('also noisy');

    expect(debug).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('includes the label and forwards extra args', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const logger = createLogger('my-label');
    const extra = { detail: 1 };
    logger.info('message', extra);

    expect(info).toHaveBeenCalledOnce();
    const [prefix, ...rest] = info.mock.calls[0];
    expect(prefix).toContain('[my-label]');
    expect(rest).toEqual(['message', extra]);
  });
});
