import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configureAppIdentity } from './app-identity';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'shadergrove-identity-'));
  roots.push(root);
  const paths = new Map<string, string>();
  const app = {
    getPath: vi.fn(() => root),
    setPath: vi.fn((name: string, path: string) => {
      if (!existsSync(path)) throw new Error('Electron requires an existing directory');
      paths.set(name, path);
    }),
    setName: vi.fn(),
  };
  return { root, paths, app };
}

describe('Shadergrove desktop identity', () => {
  it('reuses an existing installed library and Chromium profile without moving them', () => {
    const { root, paths, app } = fixture();
    const previous = join(root, 'Shader Studio');
    mkdirSync(join(previous, 'library'), { recursive: true });
    const libraryFile = join(previous, 'library', 'shader-studio.sqlite');
    writeFileSync(libraryFile, 'existing library');
    writeFileSync(join(previous, 'account.json'), 'existing credentials');

    configureAppIdentity(app, true);

    expect(paths.get('userData')).toBe(previous);
    expect(paths.get('sessionData')).toBe(previous);
    expect(readFileSync(libraryFile, 'utf8')).toBe('existing library');
    expect(readFileSync(join(previous, 'account.json'), 'utf8')).toBe('existing credentials');
    expect(existsSync(join(root, 'Shadergrove'))).toBe(false);
    expect(app.setName).toHaveBeenCalledWith('Shadergrove');
  });

  it('creates the stable profile directory before configuring a fresh installation', () => {
    const { root, paths, app } = fixture();
    configureAppIdentity(app, true);
    expect(paths.get('userData')).toBe(join(root, 'Shader Studio'));
    expect(existsSync(paths.get('sessionData')!)).toBe(true);
  });

  it('keeps development data separate from the installed profile', () => {
    const { root, paths, app } = fixture();
    configureAppIdentity(app, false);
    expect(paths.get('userData')).toBe(join(root, 'shader-studio'));
    expect(paths.get('sessionData')).toBe(join(root, 'shader-studio'));
    expect(existsSync(join(root, 'Shader Studio'))).toBe(false);
  });
});
