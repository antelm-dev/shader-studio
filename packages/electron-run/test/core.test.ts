import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { killTree } = vi.hoisted(() => ({ killTree: vi.fn(async () => {}) }));

vi.mock('../src/process.js', () => ({
  resolveElectronBinary: () => 'electron-binary',
  killTree,
  clearTerminal: vi.fn(),
}));

import { createElectronRunner } from '../src/core.js';
import { listPidFiles } from '../src/pid-file.js';
import type { LoggerLike } from '../src/logger.js';

class FakeChild extends EventEmitter {
  pid = 12_345;
}

function captureLogger() {
  const messages: string[] = [];
  const record =
    (...prefix: string[]) =>
    (...args: unknown[]) => {
      messages.push([...prefix, ...args.map(String)].join(' '));
    };
  const logger: LoggerLike = {
    error: record('error'),
    warn: record('warn'),
    info: record('info'),
    debug: record('debug'),
  };
  return { logger, messages };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 40));

let cwd: string;
let outDir: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-run-cwd-'));
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-run-out-'));
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('createElectronRunner', () => {
  it('does not spawn when the entry file is missing', async () => {
    const spawn = vi.spyOn(cp, 'spawn');
    const { logger, messages } = captureLogger();

    const runner = createElectronRunner({
      cwd,
      debounceMs: 1,
      stdinControls: false,
      logger,
    });

    runner.scheduleRestart({ dir: outDir });
    await flush();
    await runner.close();

    expect(spawn).not.toHaveBeenCalled();
    expect(messages.some((m) => m.includes('Entry file not found'))).toBe(true);
  });

  it('spawns Electron with resolved args and writes a pid file', async () => {
    fs.writeFileSync(path.join(outDir, 'main.js'), '// entry', 'utf-8');
    const child = new FakeChild();
    const spawn = vi.spyOn(cp, 'spawn').mockReturnValue(child as never);
    const { logger } = captureLogger();

    const runner = createElectronRunner({
      cwd,
      debounceMs: 1,
      additionalArgs: ['--inspect'],
      stdinControls: false,
      logger,
    });

    runner.scheduleRestart({ dir: outDir });
    await flush();

    expect(spawn).toHaveBeenCalledOnce();
    const [bin, args] = spawn.mock.calls[0];
    expect(bin).toBe('electron-binary');
    expect(args).toEqual(['--inspect', path.resolve(outDir, 'main.js')]);
    expect(listPidFiles(cwd)).toHaveLength(1);

    await runner.close();
    expect(killTree).toHaveBeenCalledWith(child.pid);
    expect(listPidFiles(cwd)).toHaveLength(0);
  });

  it('debounces rapid restart requests into a single launch', async () => {
    fs.writeFileSync(path.join(outDir, 'main.js'), '// entry', 'utf-8');
    const spawn = vi.spyOn(cp, 'spawn').mockReturnValue(new FakeChild() as never);
    const { logger } = captureLogger();

    const runner = createElectronRunner({
      cwd,
      debounceMs: 20,
      stdinControls: false,
      logger,
    });

    runner.scheduleRestart({ dir: outDir });
    runner.scheduleRestart({ dir: outDir });
    runner.scheduleRestart({ dir: outDir });
    await flush();

    expect(spawn).toHaveBeenCalledOnce();
    await runner.close();
  });
});
