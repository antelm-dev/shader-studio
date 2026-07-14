import { beforeEach, describe, expect, it } from 'vitest';

import { composePass, locate, passDependsOn } from './pass-source';
import {
  addBuffer,
  addFile,
  bufferPasses,
  commonPass,
  imagePass,
  migrateLegacyProject,
  resetIdCounter,
  setFileSource,
  setPassSource,
  type ShaderProject,
} from './index';

const VERTEX = 'void main() {}';

function base(): ShaderProject {
  return migrateLegacyProject('IMAGE', VERTEX);
}

/** Add a file with a body, and hand back its id. */
function fileWith(project: ShaderProject, name: string, source: string): [ShaderProject, string] {
  const added = addFile(project, name);
  const file = added.files.at(-1)!;
  return [setFileSource(added, file.id, source), file.id];
}

beforeEach(() => resetIdCounter());

describe('composePass', () => {
  it('compiles a pass on its own when Common is empty', () => {
    const project = base();
    const { source, errors } = composePass(project, imagePass(project));

    // An empty Common must contribute *nothing* — not even a blank line, which
    // would shift every diagnostic after it by one.
    expect(source).toBe('IMAGE');
    expect(errors).toEqual([]);
  });

  it('puts Common in front of every pass', () => {
    let project = base();
    const common = commonPass(project)!;
    project = setPassSource(project, common.id, '#define PI 3.14');
    project = addBuffer(project);

    const image = composePass(project, imagePass(project));
    const buffer = composePass(project, bufferPasses(project)[0]);

    expect(image.source).toBe('#define PI 3.14\nIMAGE');
    expect(buffer.source.startsWith('#define PI 3.14\n')).toBe(true);
  });

  it('expands an #include in place', () => {
    let project: ShaderProject = base();
    let id: string;
    [project, id] = fileWith(project, 'lib.glsl', 'float lib() { return 1.0; }');
    void id;

    project = setPassSource(project, imagePass(project).id, 'before\n#include "lib.glsl"\nafter');

    const { source, errors } = composePass(project, imagePass(project));

    // The directive itself is gone: GLSL has no #include, so leaving it in would
    // be a compile error of its own.
    expect(source).toBe('before\nfloat lib() { return 1.0; }\nafter');
    expect(errors).toEqual([]);
  });

  it('expands a nested #include', () => {
    let project: ShaderProject = base();
    [project] = fileWith(project, 'inner.glsl', 'INNER');
    [project] = fileWith(project, 'outer.glsl', 'a\n#include "inner.glsl"\nb');
    project = setPassSource(project, imagePass(project).id, '#include "outer.glsl"');

    expect(composePass(project, imagePass(project)).source).toBe('a\nINNER\nb');
  });

  it('reports an #include of a file that is not there, and keeps the line count', () => {
    let project = base();
    project = setPassSource(project, imagePass(project).id, 'a\n#include "nope.glsl"\nb');

    const { source, errors } = composePass(project, imagePass(project));

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('nope.glsl');
    expect(errors[0].line).toBe(2);
    // A blank line stands in for the failed include, so that everything after it
    // does not shift and produce a second, spurious set of errors.
    expect(source.split('\n')).toHaveLength(3);
  });

  it('reports a circular #include instead of recursing forever', () => {
    let project: ShaderProject = base();
    [project] = fileWith(project, 'a.glsl', '#include "b.glsl"');
    [project] = fileWith(project, 'b.glsl', '#include "a.glsl"');
    project = setPassSource(project, imagePass(project).id, '#include "a.glsl"');

    const { errors } = composePass(project, imagePass(project));

    expect(errors.some((error) => error.message.includes('Circular #include'))).toBe(true);
  });

  it('lets two passes include the same file without complaint', () => {
    let project: ShaderProject = base();
    [project] = fileWith(project, 'lib.glsl', 'LIB');
    project = addBuffer(project);
    project = setPassSource(project, imagePass(project).id, '#include "lib.glsl"');
    project = setPassSource(project, bufferPasses(project)[0].id, '#include "lib.glsl"');

    expect(composePass(project, imagePass(project)).errors).toEqual([]);
    expect(composePass(project, bufferPasses(project)[0]).errors).toEqual([]);
  });
});

describe('locate', () => {
  it('maps a line of the pass back to the pass', () => {
    let project = base();
    project = setPassSource(project, imagePass(project).id, 'one\ntwo\nthree');

    const { spans } = composePass(project, imagePass(project));

    expect(locate(spans, 2)).toEqual({
      docId: imagePass(project).id,
      docName: 'Image',
      line: 2,
    });
  });

  it('maps a line that came from Common back to Common, not to the pass', () => {
    let project = base();
    const common = commonPass(project)!;
    project = setPassSource(project, common.id, 'c1\nc2\nc3');
    project = setPassSource(project, imagePass(project).id, 'i1\ni2');

    const { spans } = composePass(project, imagePass(project));

    // Composed line 2 is Common's line 2 …
    expect(locate(spans, 2)).toEqual({ docId: common.id, docName: 'Common', line: 2 });
    // … and composed line 4 is the pass's line 1. Without this, every error in a
    // project with a Common pass would point at the wrong file.
    expect(locate(spans, 4)).toEqual({
      docId: imagePass(project).id,
      docName: 'Image',
      line: 1,
    });
  });

  it('maps a line inside an #include back to the included file', () => {
    let project: ShaderProject = base();
    let libId: string;
    [project, libId] = fileWith(project, 'lib.glsl', 'L1\nL2\nL3');

    project = setPassSource(project, imagePass(project).id, 'i1\n#include "lib.glsl"\ni3');

    const { source, spans } = composePass(project, imagePass(project));
    expect(source).toBe('i1\nL1\nL2\nL3\ni3');

    expect(locate(spans, 1)?.docId).toBe(imagePass(project).id);
    expect(locate(spans, 3)).toEqual({ docId: libId, docName: 'lib.glsl', line: 2 });

    // The line *after* the include is the pass's line 3, not its line 2: the
    // include grew by two lines and the map has to have absorbed that.
    expect(locate(spans, 5)).toEqual({
      docId: imagePass(project).id,
      docName: 'Image',
      line: 3,
    });
  });

  it('returns null for a line outside every span', () => {
    const project = base();
    const { spans } = composePass(project, imagePass(project));

    expect(locate(spans, 999)).toBeNull();
  });
});

describe('passDependsOn', () => {
  it('names the pass itself', () => {
    const project = base();
    expect(passDependsOn(project, imagePass(project))).toContain(imagePass(project).id);
  });

  it('names Common when Common has anything in it', () => {
    let project = base();
    const common = commonPass(project)!;

    // An empty Common is not a dependency: editing it recompiles nothing.
    expect(passDependsOn(project, imagePass(project)).has(common.id)).toBe(false);

    project = setPassSource(project, common.id, '#define X');
    expect(passDependsOn(project, imagePass(project)).has(common.id)).toBe(true);
  });

  it('names an included file, so editing it recompiles what included it', () => {
    let project: ShaderProject = base();
    let libId: string;
    [project, libId] = fileWith(project, 'lib.glsl', 'LIB');
    project = setPassSource(project, imagePass(project).id, '#include "lib.glsl"');

    expect(passDependsOn(project, imagePass(project)).has(libId)).toBe(true);

    // …and does not name a file nobody included.
    const [withOrphan, orphanId] = fileWith(project, 'orphan.glsl', 'X');
    expect(passDependsOn(withOrphan, imagePass(withOrphan)).has(orphanId)).toBe(false);
  });
});
