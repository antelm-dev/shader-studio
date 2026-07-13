import cp from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearTerminal, killTree } from '../src/process.js';

const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

afterEach(() => {
  setPlatform(originalPlatform);
  vi.restoreAllMocks();
});

describe('killTree', () => {
  it('resolves immediately when no pid is given', async () => {
    await expect(killTree(undefined)).resolves.toBeUndefined();
  });

  it('uses taskkill on win32', async () => {
    setPlatform('win32');
    const execFile = vi.spyOn(cp, 'execFile').mockImplementation(((...callArgs: unknown[]) => {
      const cb = callArgs.at(-1) as (err: Error | null) => void;
      cb(null);
      return {};
    }) as never);

    await killTree(4242);

    expect(execFile).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '4242', '/T', '/F'],
      expect.any(Function),
    );
  });

  it('sends SIGTERM on posix platforms', async () => {
    setPlatform('linux');
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);

    await killTree(555);

    expect(kill).toHaveBeenCalledWith(555, 'SIGTERM');
  });

  it('tolerates an already-dead process (ESRCH)', async () => {
    setPlatform('linux');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('no such process') as NodeJS.ErrnoException;
      error.code = 'ESRCH';
      throw error;
    });

    await expect(killTree(1)).resolves.toBeUndefined();
  });

  it('rejects on unexpected kill errors', async () => {
    setPlatform('linux');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('not permitted') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    });

    await expect(killTree(1)).rejects.toThrow('not permitted');
  });
});

describe('clearTerminal', () => {
  it('writes an ANSI clear sequence to stdout', () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    clearTerminal();
    expect(write).toHaveBeenCalledWith('\x1b[2J\x1b[3J\x1b[H');
  });
});
