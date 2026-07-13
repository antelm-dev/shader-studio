import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger.js';
import {
  listPidFiles,
  pidFilePath,
  readPidInfo,
  removePidFile,
  writePidFile,
} from '../src/pid-file.js';
import type { LaunchContext } from '../src/types.js';

const silentLogger = createLogger('test', 'error');

const launchContext: LaunchContext = {
  cwd: '/project',
  env: {},
  entryFile: '/project/out/main.js',
  additionalArgs: ['--inspect'],
  clearScreen: false,
};

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-run-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('pidFilePath', () => {
  it('builds a prefixed, unique path in cwd', () => {
    const result = pidFilePath(dir, 1234, 5678);
    expect(path.dirname(result)).toBe(path.resolve(dir));
    expect(path.basename(result)).toBe('electron-run-1234-5678.json');
  });
});

describe('writePidFile / readPidInfo', () => {
  it('round-trips a launch snapshot', () => {
    const file = pidFilePath(dir, 1, 2);
    writePidFile(file, launchContext, 999, '2026-01-01T00:00:00.000Z');

    const info = readPidInfo(file, silentLogger);
    expect(info).toEqual({
      pid: 999,
      startedAt: '2026-01-01T00:00:00.000Z',
      entry: '/project/out/main.js',
      args: ['--inspect'],
      cwd: '/project',
    });
  });

  it('returns null and warns on unreadable files', () => {
    const warn = vi.fn();
    const logger = { ...silentLogger, warn };
    const info = readPidInfo(path.join(dir, 'does-not-exist.json'), logger);
    expect(info).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('returns null on malformed JSON', () => {
    const file = path.join(dir, 'electron-run-bad.json');
    fs.writeFileSync(file, '{not json', 'utf-8');
    expect(readPidInfo(file, silentLogger)).toBeNull();
  });
});

describe('listPidFiles', () => {
  it('lists only matching pid files', () => {
    writePidFile(pidFilePath(dir, 1, 1), launchContext, 1, 't');
    writePidFile(pidFilePath(dir, 2, 2), launchContext, 2, 't');
    fs.writeFileSync(path.join(dir, 'unrelated.json'), '{}', 'utf-8');
    fs.writeFileSync(path.join(dir, 'electron-run-note.txt'), 'x', 'utf-8');

    const files = listPidFiles(dir);
    expect(files).toHaveLength(2);
    for (const file of files) {
      expect(path.basename(file)).toMatch(/^electron-run-.*\.json$/);
    }
  });
});

describe('removePidFile', () => {
  it('deletes an existing file', () => {
    const file = pidFilePath(dir, 3, 3);
    writePidFile(file, launchContext, 3, 't');
    removePidFile(file, silentLogger);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('is a no-op for a missing file', () => {
    expect(() => removePidFile(path.join(dir, 'nope.json'), silentLogger)).not.toThrow();
  });

  it('warns when no path is provided', () => {
    const warn = vi.fn();
    removePidFile(null, { ...silentLogger, warn });
    expect(warn).toHaveBeenCalledOnce();
  });
});
