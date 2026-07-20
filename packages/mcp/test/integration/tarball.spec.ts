import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Verifies the package a real user gets from `npm install`/`npx` — built via
 * `npm pack` (not a workspace symlink), inspected for stray source/fixtures,
 * then actually installed into a throwaway directory and executed.
 */

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const distPath = path.join(packageRoot, 'dist/server.mjs');

let scratchDir: string;
let tarballPath: string;

interface NpmPackEntry {
  filename: string;
  files: Array<{ path: string }>;
}

function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timed out waiting for: ${label}`));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

beforeAll(() => {
  if (!existsSync(distPath)) {
    throw new Error(
      `Expected a built server at ${distPath}. Run \`pnpm build:mcp\` before running these tests.`,
    );
  }
  scratchDir = mkdtempSync(path.join(tmpdir(), 'shader-studio-mcp-pack-'));
});

afterAll(() => {
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

describe('npm tarball', () => {
  it('contains only the compiled distribution, README, LICENSE, and package.json', () => {
    const output = execFileSync('npm', ['pack', '--json', '--pack-destination', scratchDir], {
      cwd: packageRoot,
      encoding: 'utf8',
    });
    const [entry] = JSON.parse(output) as NpmPackEntry[];
    if (!entry) throw new Error('npm pack produced no output');
    tarballPath = path.join(scratchDir, entry.filename);

    const files = entry.files.map((f) => f.path.replace(/\\/g, '/'));

    expect(files).toContain('dist/server.mjs');
    expect(files).toContain('README.md');
    expect(files).toContain('LICENSE');
    expect(files).toContain('package.json');

    for (const file of files) {
      expect(file, `${file} should not be TypeScript source`).not.toMatch(/\.ts$/);
      expect(file, `${file} should not come from src/`).not.toMatch(/^src\//);
      expect(file, `${file} should not come from test/`).not.toMatch(/^test\//);
      expect(file, `${file} should not come from scripts/`).not.toMatch(/^scripts\//);
      expect(file, `${file} should not be a node_modules path`).not.toMatch(/node_modules/);
      expect(file).not.toBe('tsconfig.json');
      expect(file).not.toBe('rollup.config.mjs');
      expect(file).not.toBe('vitest.config.ts');
    }
  });

  it('installs from the tarball into a temp directory and exposes the bin', () => {
    expect(tarballPath, 'the pack test must run first').toBeTruthy();

    const installDir = mkdtempSync(path.join(tmpdir(), 'shader-studio-mcp-install-'));
    writeFileSync(
      path.join(installDir, 'package.json'),
      JSON.stringify({ name: 'shader-studio-mcp-install-smoke-test', private: true }),
    );

    execFileSync('npm', ['install', tarballPath, '--no-save', '--no-audit', '--no-fund'], {
      cwd: installDir,
      stdio: 'pipe',
    });

    const installedServer = path.join(
      installDir,
      'node_modules/@shader-studio/mcp/dist/server.mjs',
    );
    expect(existsSync(installedServer)).toBe(true);

    const installedPkg = JSON.parse(
      readFileSync(path.join(installDir, 'node_modules/@shader-studio/mcp/package.json'), 'utf8'),
    ) as { bin?: Record<string, string> };
    expect(installedPkg.bin).toMatchObject({ 'shader-studio-mcp': './dist/server.mjs' });

    const binName = process.platform === 'win32' ? 'shader-studio-mcp.cmd' : 'shader-studio-mcp';
    expect(existsSync(path.join(installDir, 'node_modules/.bin', binName))).toBe(true);

    rmSync(installDir, { recursive: true, force: true });
  });

  it('starts and exits cleanly when run from the installed tarball', async () => {
    expect(tarballPath, 'the pack test must run first').toBeTruthy();

    const installDir = mkdtempSync(path.join(tmpdir(), 'shader-studio-mcp-run-'));
    writeFileSync(
      path.join(installDir, 'package.json'),
      JSON.stringify({ name: 'shader-studio-mcp-run-smoke-test', private: true }),
    );
    execFileSync('npm', ['install', tarballPath, '--no-save', '--no-audit', '--no-fund'], {
      cwd: installDir,
      stdio: 'pipe',
    });

    const installedServer = path.join(
      installDir,
      'node_modules/@shader-studio/mcp/dist/server.mjs',
    );

    let child: ChildProcess | null = null;
    try {
      child = spawn(process.execPath, [installedServer], {
        env: {
          ...process.env,
          SHADER_STUDIO_MCP_PORT: '43299',
          SHADER_STUDIO_MCP_TOKEN: 'tarball-run-test-token',
        },
        stdio: ['pipe', 'ignore', 'pipe'],
      });

      const stderrChunks: string[] = [];
      child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString('utf8')));
      await waitFor(
        () => stderrChunks.join('').includes('listening'),
        5000,
        'bridge listening log',
      );

      // Closing stdin (rather than a signal) shuts the server down cleanly
      // cross-platform — on Windows, `kill('SIGTERM')` unconditionally
      // terminates the process instead of delivering a catchable signal.
      child.stdin?.end();
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for exit')), 5000);
        child?.once('exit', (exitCode) => {
          clearTimeout(timer);
          resolve(exitCode);
        });
      });
      expect(code).toBe(0);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      rmSync(installDir, { recursive: true, force: true });
    }
  });
});
