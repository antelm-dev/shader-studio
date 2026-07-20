import { describe, expect, it } from 'vitest';

import { OutputLog } from './output-log';

describe('OutputLog', () => {
  it('starts empty', () => {
    expect(new OutputLog().entries()).toEqual([]);
  });

  it('appends entries in chronological order', () => {
    const log = new OutputLog();
    log.info('compiler', 'first');
    log.warning('renderer', 'second');
    log.error('workspace', 'third');

    expect(log.entries().map((entry) => entry.message)).toEqual(['first', 'second', 'third']);
    expect(log.entries().map((entry) => entry.level)).toEqual(['info', 'warning', 'error']);
    expect(log.entries().map((entry) => entry.source)).toEqual([
      'compiler',
      'renderer',
      'workspace',
    ]);
  });

  it('assigns each entry a stable, increasing id', () => {
    const log = new OutputLog();
    log.info('compiler', 'a');
    log.info('compiler', 'b');
    const [first, second] = log.entries();
    expect(second.id).toBeGreaterThan(first.id);
  });

  it('write() honours the level passed to it', () => {
    const log = new OutputLog();
    log.write('error', 'mcp', 'boom');
    expect(log.entries()[0]).toMatchObject({ level: 'error', source: 'mcp', message: 'boom' });
  });

  it('keeps a bounded number of entries, dropping the oldest first', () => {
    const log = new OutputLog();
    for (let i = 0; i < 600; i++) log.info('compiler', `entry-${i}`);

    const entries = log.entries();
    expect(entries.length).toBeLessThanOrEqual(500);
    // The oldest entries are the ones dropped — what's left is a contiguous,
    // still-chronological tail ending at the last one written.
    expect(entries.at(-1)?.message).toBe('entry-599');
    expect(entries[0].message).not.toBe('entry-0');
  });

  it('clear() empties the log', () => {
    const log = new OutputLog();
    log.info('compiler', 'a');
    log.clear();
    expect(log.entries()).toEqual([]);
  });
});
