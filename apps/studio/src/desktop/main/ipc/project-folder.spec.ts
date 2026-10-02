import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_PROJECT_BYTES,
  sanitizeProjectStem,
  validateProjectFiles,
  writeProjectFolder,
} from './project-folder';

/** Fails the n-th `writeFile` once armed; passes through otherwise. */
const disk = vi.hoisted(() => ({ failOn: 0, calls: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: (async (...args: Parameters<typeof actual.writeFile>) => {
      if (disk.failOn && ++disk.calls === disk.failOn) throw new Error('disk full');
      return actual.writeFile(...args);
    }) as typeof actual.writeFile,
  };
});

const text = (value: string) => new TextEncoder().encode(value);
const project = () => [
  { path: 'index.html', bytes: text('<!doctype html><title>x</title>') },
  { path: 'project.json', bytes: text('{"file":"index.html","type":"web"}') },
];

describe('project folder delivery', () => {
  let parent: string;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'sg-project-'));
  });
  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it('writes a complete folder and never overwrites an existing one', async () => {
    const first = await writeProjectFolder(parent, 'Neon Rain', project());
    expect(first).toBe(join(parent, 'Neon-Rain'));
    expect(await readFile(join(first, 'project.json'), 'utf8')).toContain('index.html');

    await writeFile(join(first, 'mine.txt'), 'keep me');
    const second = await writeProjectFolder(parent, 'Neon Rain', project());
    expect(second).toBe(join(parent, 'Neon-Rain-2'));
    expect(await readFile(join(first, 'mine.txt'), 'utf8')).toBe('keep me');
    expect((await readdir(parent)).sort()).toEqual(['Neon-Rain', 'Neon-Rain-2']);
  });

  it('reduces hostile stems to a leaf name', () => {
    expect(sanitizeProjectStem('../../etc/passwd')).toBe('etc-passwd');
    expect(sanitizeProjectStem('C:\\Windows\\x')).toBe('C-Windows-x');
    expect(sanitizeProjectStem('...')).toBe('shader-project');
    expect(sanitizeProjectStem(undefined)).toBe('shader-project');
  });

  it('refuses paths, sizes and payloads a runtime does not produce', () => {
    const bad = (files: unknown) => validateProjectFiles(files);
    expect(bad(project())).toHaveLength(2);
    expect(bad([...project(), { path: '../evil.js', bytes: text('x') }])).toMatch(/path/);
    expect(bad([...project(), { path: 'textures/../../x.png', bytes: text('x') }])).toMatch(/path/);
    expect(bad([...project(), { path: 'payload.exe', bytes: text('x') }])).toMatch(/path/);
    expect(bad([...project(), project()[0]])).toMatch(/path/);
    expect(bad([{ path: 'project.json', bytes: text('{}') }])).toMatch(/index.html/);
    expect(bad([{ path: 'index.html', bytes: text('MZ') }])).toMatch(/index.html/);
    expect(
      bad([project()[0], { path: 'project.json', bytes: text('{"file":"evil.html"}') }]),
    ).toMatch(/point at index.html/);
    expect(
      bad([
        project()[0],
        { path: 'textures/channel0.png', bytes: new Uint8Array(MAX_PROJECT_BYTES) },
      ]),
    ).toMatch(/too large/);
    expect(bad('nope')).toMatch(/1 to 8/);
  });

  it('leaves nothing behind when a write fails part way', async () => {
    // A parent that does not exist fails before anything is written.
    const files = [
      ...project(),
      { path: 'textures/channel0.png', bytes: new Uint8Array([1, 2, 3]) },
    ];
    const blocked = join(parent, 'blocked');
    await mkdir(blocked);
    await expect(
      writeProjectFolder(join(blocked, 'missing-parent'), 'Broken', files),
    ).rejects.toThrow();
    expect(await readdir(blocked)).toEqual([]);

    disk.calls = 0;
    disk.failOn = 2;
    await expect(writeProjectFolder(parent, 'Broken', files)).rejects.toThrow(/disk full/);
    disk.failOn = 0;
    expect(await readdir(parent)).toEqual(['blocked']);
  });
});
