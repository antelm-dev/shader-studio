import { beforeEach, describe, expect, it } from 'vitest';

import {
  addBuffer,
  addFile,
  bufferPasses,
  commonPass,
  displayPasses,
  duplicateFile,
  duplicatePass,
  findFile,
  findPass,
  freeSlot,
  imagePass,
  migrateLegacyProject,
  movePass,
  moveFile,
  removeFile,
  removePass,
  renameFile,
  renamePass,
  resetIdCounter,
  resolvePassOrder,
  sanitizeProject,
  setChannelBinding,
  setPassEnabled,
  setPassResolution,
  setPassSource,
  type ChannelIndex,
  type ShaderProject,
} from './index';

const FRAGMENT = 'void main() { gl_FragColor = vec4(1.0); }';
const VERTEX = 'void main() { gl_Position = vec4(position, 1.0); }';

function base(): ShaderProject {
  return migrateLegacyProject(FRAGMENT, VERTEX);
}

/** A project with `count` buffers, in slots A, B, … */
function withBuffers(count: number): ShaderProject {
  let project = base();
  for (let n = 0; n < count; n++) project = addBuffer(project);
  return project;
}

function bind(
  project: ShaderProject,
  passId: string,
  channel: ChannelIndex,
  targetId: string,
  feedback = false,
): ShaderProject {
  return setChannelBinding(project, passId, channel, {
    kind: 'buffer',
    passId: targetId,
    feedback,
  });
}

beforeEach(() => resetIdCounter());

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

describe('migrateLegacyProject', () => {
  it('turns a single-shader record into an Image pass and an empty Common', () => {
    const project = base();

    expect(imagePass(project).source).toBe(FRAGMENT);
    expect(project.vertex).toBe(VERTEX);
    expect(commonPass(project)?.source).toBe('');
    expect(bufferPasses(project)).toHaveLength(0);
  });

  it('binds the four texture slots exactly as the old engine did', () => {
    // A legacy shader sampling iChannel2 must keep sampling texture slot 2, or
    // every existing shader with an image in it comes back wrong.
    expect(imagePass(base()).channels).toEqual([
      { kind: 'texture', slot: 0 },
      { kind: 'texture', slot: 1 },
      { kind: 'texture', slot: 2 },
      { kind: 'texture', slot: 3 },
    ]);
  });

  it('leaves the Image pass always enabled and unslotted', () => {
    const image = imagePass(base());
    expect(image.enabled).toBe(true);
    expect(image.slot).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

describe('file operations', () => {
  it('creates, renames, duplicates, reorders and deletes', () => {
    let project = addFile(base(), 'noise.glsl');
    const noise = project.files[0];
    expect(noise.name).toBe('noise.glsl');

    project = renameFile(project, noise.id, 'sdf.glsl');
    expect(findFile(project, noise.id)?.name).toBe('sdf.glsl');

    project = duplicateFile(project, noise.id);
    expect(project.files.map((file) => file.name)).toEqual(['sdf.glsl', 'sdf.glsl copy']);

    project = addFile(project, 'third.glsl');
    project = moveFile(project, project.files[2].id, 0);
    expect(project.files.map((file) => file.name)).toEqual([
      'third.glsl',
      'sdf.glsl',
      'sdf.glsl copy',
    ]);

    project = removeFile(project, noise.id);
    expect(project.files.map((file) => file.name)).toEqual(['third.glsl', 'sdf.glsl copy']);
  });

  it('never lets two files share a name', () => {
    // `#include` addresses a file by name, so a duplicate name is an ambiguity
    // the composer could not resolve.
    let project = addFile(base(), 'lib.glsl');
    project = addFile(project, 'lib.glsl');
    project = addFile(project, 'lib.glsl');

    expect(project.files.map((file) => file.name)).toEqual([
      'lib.glsl',
      'lib.glsl 2',
      'lib.glsl 3',
    ]);
  });

  it('renaming onto a taken name disambiguates rather than colliding', () => {
    let project = addFile(addFile(base(), 'a.glsl'), 'b.glsl');
    project = renameFile(project, project.files[1].id, 'a.glsl');

    expect(project.files.map((file) => file.name)).toEqual(['a.glsl', 'a.glsl 2']);
  });

  it('renaming to blank is a no-op', () => {
    const project = addFile(base(), 'a.glsl');
    expect(renameFile(project, project.files[0].id, '   ').files[0].name).toBe('a.glsl');
  });
});

// ---------------------------------------------------------------------------
// Passes
// ---------------------------------------------------------------------------

describe('pass operations', () => {
  it('adds buffers into the first free slot, and stops at four', () => {
    const project = withBuffers(5);

    expect(bufferPasses(project).map((pass) => pass.slot)).toEqual(['A', 'B', 'C', 'D']);
    expect(freeSlot(project)).toBeNull();
  });

  it('reuses a slot freed by a deletion', () => {
    let project = withBuffers(3);
    const b = bufferPasses(project)[1];

    project = removePass(project, b.id);
    project = addBuffer(project);

    expect(
      bufferPasses(project)
        .map((pass) => pass.slot)
        .sort(),
    ).toEqual(['A', 'B', 'C']);
  });

  it('shows Image first, then Common, then the buffers', () => {
    const project = withBuffers(2);
    expect(displayPasses(project).map((pass) => pass.name)).toEqual([
      'Image',
      'Common',
      'Buffer A',
      'Buffer B',
    ]);
  });

  it('reorders buffers without disturbing Image or Common', () => {
    let project = withBuffers(3);
    const c = bufferPasses(project)[2];

    project = movePass(project, c.id, 0);

    expect(bufferPasses(project).map((pass) => pass.name)).toEqual([
      'Buffer C',
      'Buffer A',
      'Buffer B',
    ]);
    // The slots travel with the passes: a slot is identity, not position.
    expect(bufferPasses(project).map((pass) => pass.slot)).toEqual(['C', 'A', 'B']);
    expect(displayPasses(project)[0].kind).toBe('image');
    expect(displayPasses(project)[1].kind).toBe('common');
  });

  it('disables and re-enables a buffer, but never the Image pass', () => {
    let project = withBuffers(1);
    const a = bufferPasses(project)[0];

    project = setPassEnabled(project, a.id, false);
    expect(findPass(project, a.id)?.enabled).toBe(false);

    project = setPassEnabled(project, imagePass(project).id, false);
    expect(imagePass(project).enabled).toBe(true);
  });

  it('renames a pass', () => {
    let project = withBuffers(1);
    const a = bufferPasses(project)[0];

    project = renamePass(project, a.id, 'Fluid');
    expect(findPass(project, a.id)?.name).toBe('Fluid');
  });

  it('clears every binding that pointed at a deleted buffer', () => {
    let project = withBuffers(2);
    const [a, b] = bufferPasses(project);

    project = bind(project, imagePass(project).id, 0, a.id);
    project = bind(project, b.id, 1, a.id);

    project = removePass(project, a.id);

    // Otherwise one deletion becomes a dangling reference in every consumer.
    expect(imagePass(project).channels[0]).toEqual({ kind: 'none' });
    expect(findPass(project, b.id)?.channels[1]).toEqual({ kind: 'none' });
  });

  it('duplicating a buffer rewrites its self-feedback onto the copy', () => {
    let project = withBuffers(1);
    const a = bufferPasses(project)[0];

    project = bind(project, a.id, 0, a.id, true);
    project = setPassSource(project, a.id, 'trail');
    project = duplicatePass(project, a.id);

    const copy = bufferPasses(project)[1];
    expect(copy.slot).toBe('B');
    expect(copy.source).toBe('trail');
    // The copy reads its *own* history — a duplicate that shared the original's
    // feedback would be an alias, not a copy.
    expect(copy.channels[0]).toEqual({ kind: 'buffer', passId: copy.id, feedback: true });
  });

  it('duplicating a buffer keeps a binding to a *different* buffer pointing there', () => {
    let project = withBuffers(2);
    const [a, b] = bufferPasses(project);

    project = bind(project, a.id, 2, b.id);
    project = duplicatePass(project, a.id);

    const copy = bufferPasses(project).find((pass) => pass.slot === 'C');
    expect(copy?.channels[2]).toEqual({ kind: 'buffer', passId: b.id, feedback: false });
  });

  it('refuses to duplicate when every slot is taken', () => {
    const project = withBuffers(4);
    const a = bufferPasses(project)[0];

    expect(duplicatePass(project, a.id)).toBe(project);
  });

  it('clamps a resolution back into range', () => {
    let project = withBuffers(1);
    const a = bufferPasses(project)[0];

    project = setPassResolution(project, a.id, { mode: 'fixed', width: 99_999, height: 0 });

    const resolution = findPass(project, a.id)!.resolution;
    expect(resolution.width).toBe(4096);
    expect(resolution.height).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The dependency graph
// ---------------------------------------------------------------------------

describe('resolvePassOrder', () => {
  it('puts the Image pass last, even with no buffers at all', () => {
    const { order, errors } = resolvePassOrder(base());

    expect(errors).toEqual([]);
    expect(order).toHaveLength(1);
    expect(order[0].kind).toBe('image');
  });

  it('renders a buffer before the pass that samples it', () => {
    let project = withBuffers(1);
    const a = bufferPasses(project)[0];
    project = bind(project, imagePass(project).id, 0, a.id);

    const { order, errors } = resolvePassOrder(project);

    expect(errors).toEqual([]);
    expect(order.map((pass) => pass.name)).toEqual(['Buffer A', 'Image']);
  });

  it('orders a chain of buffers deepest-first', () => {
    // A → B → Image: A feeds B, B feeds Image, so A has to go first.
    let project = withBuffers(2);
    const [a, b] = bufferPasses(project);

    project = bind(project, b.id, 0, a.id);
    project = bind(project, imagePass(project).id, 0, b.id);

    const { order, errors } = resolvePassOrder(project);

    expect(errors).toEqual([]);
    expect(order.map((pass) => pass.name)).toEqual(['Buffer A', 'Buffer B', 'Image']);
  });

  it('orders a diamond so both sides land before the pass that joins them', () => {
    let project = withBuffers(3);
    const [a, b, c] = bufferPasses(project);

    project = bind(project, b.id, 0, a.id);
    project = bind(project, c.id, 0, a.id);
    project = bind(project, imagePass(project).id, 0, b.id);
    project = bind(project, imagePass(project).id, 1, c.id);

    const { order, errors } = resolvePassOrder(project);
    const names = order.map((pass) => pass.name);

    expect(errors).toEqual([]);
    expect(names.indexOf('Buffer A')).toBeLessThan(names.indexOf('Buffer B'));
    expect(names.indexOf('Buffer A')).toBeLessThan(names.indexOf('Buffer C'));
    expect(names.at(-1)).toBe('Image');
  });

  it('renders a buffer nothing samples, and still puts Image last', () => {
    const project = withBuffers(1);

    const { order } = resolvePassOrder(project);

    expect(order.map((pass) => pass.name)).toEqual(['Buffer A', 'Image']);
  });

  it('ignores a disabled buffer entirely', () => {
    let project = withBuffers(2);
    const [a, b] = bufferPasses(project);
    project = setPassEnabled(project, b.id, false);
    project = bind(project, imagePass(project).id, 0, a.id);

    const { order, errors } = resolvePassOrder(project);

    expect(errors).toEqual([]);
    expect(order.map((pass) => pass.name)).toEqual(['Buffer A', 'Image']);
  });

  it('does not treat the buffer order in the array as a dependency', () => {
    // B is declared before A, but A feeds B. The graph wins, not the array.
    let project = withBuffers(2);
    const [a, b] = bufferPasses(project);
    project = bind(project, b.id, 0, a.id);
    project = movePass(project, b.id, 0);

    const { order } = resolvePassOrder(project);

    expect(order.map((pass) => pass.name)).toEqual(['Buffer A', 'Buffer B', 'Image']);
  });
});

// ---------------------------------------------------------------------------
// Feedback and cycles
// ---------------------------------------------------------------------------

describe('cycle detection', () => {
  it('reports a buffer that samples itself without feedback', () => {
    let project = withBuffers(1);
    const a = bufferPasses(project)[0];
    project = bind(project, a.id, 0, a.id, false);

    const { errors } = resolvePassOrder(project);

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('samples itself');
    expect(errors[0].message).toContain('feedback');
    expect(errors[0].passId).toBe(a.id);
    expect(errors[0].channel).toBe(0);
  });

  it('accepts a buffer that samples itself *with* feedback', () => {
    // The whole point: a trail reads the frame it drew last tick, which is not
    // a dependency — the texture is already there.
    let project = withBuffers(1);
    const a = bufferPasses(project)[0];
    project = bind(project, a.id, 0, a.id, true);
    project = bind(project, imagePass(project).id, 0, a.id);

    const { order, errors } = resolvePassOrder(project);

    expect(errors).toEqual([]);
    expect(order.map((pass) => pass.name)).toEqual(['Buffer A', 'Image']);
  });

  it('reports a two-buffer cycle and names the loop', () => {
    let project = withBuffers(2);
    const [a, b] = bufferPasses(project);

    project = bind(project, a.id, 0, b.id);
    project = bind(project, b.id, 0, a.id);

    const { errors } = resolvePassOrder(project);

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Circular buffer dependency');
    expect(errors[0].message).toContain('Buffer A');
    expect(errors[0].message).toContain('Buffer B');
  });

  it('reports a three-buffer cycle exactly once', () => {
    let project = withBuffers(3);
    const [a, b, c] = bufferPasses(project);

    project = bind(project, a.id, 0, b.id);
    project = bind(project, b.id, 0, c.id);
    project = bind(project, c.id, 0, a.id);

    const { errors } = resolvePassOrder(project);

    expect(errors.filter((error) => error.message.includes('Circular'))).toHaveLength(1);
  });

  it('breaks a cycle when one of its edges is feedback', () => {
    let project = withBuffers(2);
    const [a, b] = bufferPasses(project);

    project = bind(project, a.id, 0, b.id, true);
    project = bind(project, b.id, 0, a.id, false);

    const { order, errors } = resolvePassOrder(project);

    expect(errors).toEqual([]);
    expect(order.map((pass) => pass.name)).toEqual(['Buffer A', 'Buffer B', 'Image']);
  });

  it('reports a binding to a buffer that no longer exists', () => {
    let project = withBuffers(1);
    project = bind(project, imagePass(project).id, 3, 'ghost');

    const { errors } = resolvePassOrder(project);

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('no longer exists');
    expect(errors[0].channel).toBe(3);
  });

  it('reports a binding to a buffer that is switched off', () => {
    let project = withBuffers(1);
    const a = bufferPasses(project)[0];

    project = bind(project, imagePass(project).id, 1, a.id);
    project = setPassEnabled(project, a.id, false);

    const { errors } = resolvePassOrder(project);

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('disabled');
    expect(errors[0].channel).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Persistence sanitizing
// ---------------------------------------------------------------------------

describe('sanitizeProject', () => {
  it('round-trips a project through JSON unchanged', () => {
    let project = withBuffers(2);
    const [a, b] = bufferPasses(project);
    project = bind(project, b.id, 0, a.id);
    project = bind(project, a.id, 1, a.id, true);
    project = addFile(project, 'lib.glsl');

    const restored = sanitizeProject(JSON.parse(JSON.stringify(project)), FRAGMENT, VERTEX);

    expect(restored).toEqual(project);
  });

  it('falls back to the record when storage holds rubbish', () => {
    for (const rubbish of [null, undefined, 42, 'nope', []]) {
      const project = sanitizeProject(rubbish, FRAGMENT, VERTEX);

      expect(imagePass(project).source).toBe(FRAGMENT);
      expect(project.vertex).toBe(VERTEX);
    }
  });

  it('recreates an Image and a Common pass that are missing', () => {
    const project = sanitizeProject({ version: 1, passes: [], files: [] }, FRAGMENT, VERTEX);

    expect(imagePass(project).source).toBe(FRAGMENT);
    expect(commonPass(project)).not.toBeNull();
  });

  it('drops a binding pointing at a pass that did not survive', () => {
    const project = sanitizeProject(
      {
        version: 1,
        vertex: VERTEX,
        passes: [
          {
            kind: 'image',
            id: 'img',
            name: 'Image',
            source: FRAGMENT,
            channels: [{ kind: 'buffer', passId: 'gone', feedback: false }],
          },
        ],
        files: [],
      },
      FRAGMENT,
      VERTEX,
    );

    expect(imagePass(project).channels[0]).toEqual({ kind: 'none' });
  });

  it('never lets two buffers claim the same slot', () => {
    const duplicated = {
      version: 1,
      vertex: VERTEX,
      passes: [
        { kind: 'image', id: 'img', name: 'Image', source: FRAGMENT },
        { kind: 'buffer', id: 'x', name: 'Buffer A', slot: 'A', source: 'a' },
        { kind: 'buffer', id: 'y', name: 'Buffer A', slot: 'A', source: 'b' },
      ],
      files: [],
    };

    const project = sanitizeProject(duplicated, FRAGMENT, VERTEX);

    expect(bufferPasses(project).map((pass) => pass.slot)).toEqual(['A', 'B']);
  });

  it('keeps only four buffers however many were stored', () => {
    const passes = [{ kind: 'image', id: 'img', name: 'Image', source: FRAGMENT }];
    for (let n = 0; n < 9; n++) {
      passes.push({ kind: 'buffer', id: `b${n}`, name: `B${n}`, source: '' } as never);
    }

    const project = sanitizeProject({ version: 1, passes, files: [] }, FRAGMENT, VERTEX);

    expect(bufferPasses(project)).toHaveLength(4);
  });

  it('forces the Image pass back on, however it was stored', () => {
    const project = sanitizeProject(
      {
        version: 1,
        passes: [{ kind: 'image', id: 'img', name: 'Image', source: FRAGMENT, enabled: false }],
        files: [],
      },
      FRAGMENT,
      VERTEX,
    );

    expect(imagePass(project).enabled).toBe(true);
  });
});
