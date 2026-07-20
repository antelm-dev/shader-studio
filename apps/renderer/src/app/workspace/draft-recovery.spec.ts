import { DOCUMENT } from '@angular/common';
import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { addBuffer, bufferPasses, imagePass, migrateLegacyProject } from '@shader-studio/shared';
import { DraftRecovery } from './draft-recovery';
import type { ShaderDraft } from './shader-store';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const draft: ShaderDraft = {
  project: migrateLegacyProject('void main() {}', 'void main() {}'),
  controlsText: '[]',
  render: { bloom: { enabled: false, strength: 0.3, radius: 0.5, threshold: 0.85 } },
};

describe('DraftRecovery', () => {
  let storage: MemoryStorage;
  let recovery: DraftRecovery;

  beforeEach(() => {
    storage = new MemoryStorage();
    TestBed.configureTestingModule({
      providers: [
        DraftRecovery,
        { provide: PLATFORM_ID, useValue: 'browser' },
        { provide: DOCUMENT, useValue: { defaultView: { localStorage: storage } } },
      ],
    });
    recovery = TestBed.inject(DraftRecovery);
  });

  it('round-trips and removes a versioned per-shader draft', () => {
    recovery.put('waves', 'saved-at', draft);
    expect(recovery.get('waves')).toMatchObject({
      shaderId: 'waves',
      baselineUpdatedAt: 'saved-at',
    });
    expect(imagePass(recovery.get('waves')!.project).source).toBe('void main() {}');

    recovery.remove('waves');
    expect(recovery.get('waves')).toBeNull();
  });

  it('recovers the buffers and files of an unsaved project, not just the fragment', () => {
    // The whole point of the draft now being a project: a buffer you created and
    // did not save is unsaved *work*, and a reload has to give it back.
    const withBuffer: ShaderDraft = { ...draft, project: addBuffer(draft.project) };

    recovery.put('waves', 'saved-at', withBuffer);

    const recovered = recovery.get('waves')!;
    expect(bufferPasses(recovered.project)).toHaveLength(1);
    expect(bufferPasses(recovered.project)[0].slot).toBe('A');
  });

  it('refuses a draft from before projects existed rather than guessing', () => {
    // A v1 draft holds a fragment and a vertex and no passes at all. There is no
    // honest way to read it as a project, so it is dropped.
    storage.setItem(
      'shader-studio.recovered-drafts',
      JSON.stringify({
        version: 1,
        drafts: {
          waves: {
            shaderId: 'waves',
            baselineUpdatedAt: 'saved-at',
            draftUpdatedAt: 'then',
            fragment: 'old',
            vertex: 'old',
            controlsText: '[]',
            render: { bloom: { enabled: false, strength: 0, radius: 0, threshold: 1 } },
          },
        },
      }),
    );

    expect(recovery.get('waves')).toBeNull();
  });

  it('drops malformed storage instead of exposing it', () => {
    storage.setItem('shader-studio.recovered-drafts', '{broken');
    expect(recovery.get('waves')).toBeNull();
    expect(storage.length).toBe(0);
  });

  it('warns only once when storage writes fail', () => {
    const warning = vi.fn();
    recovery.onWarning = warning;
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    recovery.put('waves', 'one', draft);
    recovery.put('other', 'two', draft);
    expect(warning).toHaveBeenCalledTimes(1);
  });
});
