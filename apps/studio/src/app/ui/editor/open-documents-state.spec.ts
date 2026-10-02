import { describe, expect, it } from 'vitest';

import {
  closeDocument,
  closeOtherDocuments,
  emptyOpenDocumentsState,
  ensureShaderOpen,
  openDocument,
  openIdsFor,
  pruneOpenDocuments,
  reorderOpenDocument,
} from './open-documents-state';

const SHADER_A = 'shader-a';
const SHADER_B = 'shader-b';

describe('open-documents-state', () => {
  it('seeds a shader with only the default document', () => {
    const state = ensureShaderOpen(emptyOpenDocumentsState(), SHADER_A, 'image');
    expect(openIdsFor(state, SHADER_A)).toEqual(['image']);
  });

  it('does not re-seed an already open set', () => {
    let state = ensureShaderOpen(emptyOpenDocumentsState(), SHADER_A, 'image');
    state = openDocument(state, SHADER_A, 'vertex');
    state = ensureShaderOpen(state, SHADER_A, 'image');
    expect(openIdsFor(state, SHADER_A)).toEqual(['image', 'vertex']);
  });

  it('opens a document once and ignores duplicates', () => {
    let state = ensureShaderOpen(emptyOpenDocumentsState(), SHADER_A, 'image');
    state = openDocument(state, SHADER_A, 'common');
    state = openDocument(state, SHADER_A, 'common');
    expect(openIdsFor(state, SHADER_A)).toEqual(['image', 'common']);
  });

  it('scopes open sets by shader id', () => {
    let state = ensureShaderOpen(emptyOpenDocumentsState(), SHADER_A, 'image');
    state = openDocument(state, SHADER_A, 'vertex');
    state = ensureShaderOpen(state, SHADER_B, 'image');
    state = openDocument(state, SHADER_B, 'config');

    expect(openIdsFor(state, SHADER_A)).toEqual(['image', 'vertex']);
    expect(openIdsFor(state, SHADER_B)).toEqual(['image', 'config']);
  });

  it('closes an inactive tab without suggesting a new active id', () => {
    let state = ensureShaderOpen(emptyOpenDocumentsState(), SHADER_A, 'image');
    state = openDocument(state, SHADER_A, 'vertex');
    state = openDocument(state, SHADER_A, 'config');

    const result = closeDocument(state, SHADER_A, 'vertex');
    expect(result.closed).toBe(true);
    expect(result.nextActiveHint).toBe('config');
    expect(openIdsFor(result.state, SHADER_A)).toEqual(['image', 'config']);
  });

  it('prefers the right neighbor when closing, else the left', () => {
    let state = ensureShaderOpen(emptyOpenDocumentsState(), SHADER_A, 'a');
    state = openDocument(state, SHADER_A, 'b');
    state = openDocument(state, SHADER_A, 'c');

    const closeMiddle = closeDocument(state, SHADER_A, 'b');
    expect(closeMiddle.nextActiveHint).toBe('c');

    const closeLast = closeDocument(state, SHADER_A, 'c');
    expect(closeLast.nextActiveHint).toBe('b');
  });

  it('keeps the last tab open (last-tab rule)', () => {
    const state = ensureShaderOpen(emptyOpenDocumentsState(), SHADER_A, 'image');
    const result = closeDocument(state, SHADER_A, 'image');
    expect(result.closed).toBe(false);
    expect(openIdsFor(result.state, SHADER_A)).toEqual(['image']);
  });

  it('close others keeps only the target tab', () => {
    let state = ensureShaderOpen(emptyOpenDocumentsState(), SHADER_A, 'image');
    state = openDocument(state, SHADER_A, 'vertex');
    state = openDocument(state, SHADER_A, 'config');
    state = closeOtherDocuments(state, SHADER_A, 'vertex');
    expect(openIdsFor(state, SHADER_A)).toEqual(['vertex']);
  });

  it('reorders open tabs without requiring project order', () => {
    let state = ensureShaderOpen(emptyOpenDocumentsState(), SHADER_A, 'image');
    state = openDocument(state, SHADER_A, 'vertex');
    state = openDocument(state, SHADER_A, 'config');
    state = reorderOpenDocument(state, SHADER_A, 'config', 'image');
    expect(openIdsFor(state, SHADER_A)).toEqual(['config', 'image', 'vertex']);
  });

  it('prunes deleted documents and reseeds when empty', () => {
    let state = ensureShaderOpen(emptyOpenDocumentsState(), SHADER_A, 'image');
    state = openDocument(state, SHADER_A, 'buffer-a');
    state = pruneOpenDocuments(state, SHADER_A, new Set(['image']), 'image');
    expect(openIdsFor(state, SHADER_A)).toEqual(['image']);

    state = openDocument(state, SHADER_A, 'gone');
    state = pruneOpenDocuments(state, SHADER_A, new Set(), 'image');
    expect(openIdsFor(state, SHADER_A)).toEqual(['image']);
  });
});
