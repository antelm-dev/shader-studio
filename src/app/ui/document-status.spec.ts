import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CompileDiagnostic } from '../core/diagnostic';
import { ShaderStore } from '../core/shader-store';
import { DocumentStatus } from './document-status';

/**
 * The save predicate used to be written out by hand in three templates. These
 * tests are what stop it drifting back apart — and they pin down the one rule
 * that is easy to get backwards: a shader that does not *compile* can still be
 * saved, but a shader whose *config* does not parse cannot.
 */

/** Only the four signals `DocumentStatus` actually reads. */
class FakeStore implements Partial<ShaderStore> {
  readonly record = signal<unknown>({ id: 'waves' }) as ShaderStore['record'];
  readonly dirty = signal(false) as unknown as ShaderStore['dirty'];
  readonly saving = signal(false) as unknown as ShaderStore['saving'];
  readonly configValid = signal(true) as unknown as ShaderStore['configValid'];
  readonly diagnostics = signal<readonly CompileDiagnostic[]>([]);
}

const error = (source: CompileDiagnostic['source']): CompileDiagnostic =>
  ({ source, severity: 'error', line: 1, message: 'boom' }) as CompileDiagnostic;

const warning = (): CompileDiagnostic =>
  ({ source: 'fragment', severity: 'warning', line: 1, message: 'meh' }) as CompileDiagnostic;

describe('DocumentStatus', () => {
  let store: FakeStore;
  let status: DocumentStatus;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new FakeStore();
    TestBed.configureTestingModule({
      providers: [DocumentStatus, { provide: ShaderStore, useValue: store }],
    });
    status = TestBed.inject(DocumentStatus);
    TestBed.tick();
  });

  afterEach(() => vi.useRealTimers());

  const set = (patch: Partial<Record<'record' | 'dirty' | 'saving' | 'configValid', unknown>>) => {
    for (const [key, value] of Object.entries(patch)) {
      (store[key as keyof FakeStore] as unknown as { set(v: unknown): void }).set(value);
    }
  };

  describe('state', () => {
    it('is none with no shader open', () => {
      set({ record: null });
      expect(status.state()).toBe('none');
    });

    it('shows no status when the draft matches the record', () => {
      expect(status.state()).toBe('none');
      expect(status.label()).toBe('');
    });

    it('shows saved for three seconds after a successful save', () => {
      set({ dirty: true, saving: true });
      TestBed.tick();
      set({ dirty: false, saving: false });
      TestBed.tick();

      expect(status.state()).toBe('saved');
      expect(status.label()).toBe('Saved');

      vi.advanceTimersByTime(3_000);
      expect(status.state()).toBe('none');
    });

    it('is unsaved once the draft diverges', () => {
      set({ dirty: true });
      expect(status.state()).toBe('unsaved');
      expect(status.label()).toBe('Unsaved changes');
    });

    it('reports saving in preference to unsaved', () => {
      set({ dirty: true, saving: true });
      expect(status.state()).toBe('saving');
      expect(status.label()).toBe('Saving…');
    });
  });

  describe('canSave', () => {
    it('is false when there is nothing to save', () => {
      expect(status.canSave()).toBe(false);
      expect(status.saveHint()).toBe('No unsaved changes');
    });

    it('is true for a dirty, valid draft', () => {
      set({ dirty: true });
      expect(status.canSave()).toBe(true);
      expect(status.saveHint()).toContain('Ctrl+S');
    });

    it('is false while a save is already in flight', () => {
      set({ dirty: true, saving: true });
      expect(status.canSave()).toBe(false);
      expect(status.saveHint()).toBe('Saving…');
    });

    /**
     * The load-bearing pair. A broken config has no schema to build a record
     * from, so it blocks the save and says so. A shader that merely fails to
     * compile is the normal state of one you are working on — blocking that
     * would throw the work away.
     */
    it('is false, with a reason, when the config does not parse', () => {
      set({ dirty: true, configValid: false });
      expect(status.canSave()).toBe(false);
      expect(status.saveHint()).toBe('The Config tab has errors. Fix them before saving.');
    });

    it('is still true when the shader has compile errors', () => {
      set({ dirty: true });
      store.diagnostics.set([error('fragment')]);
      expect(status.canSave()).toBe(true);
    });

    it('explains itself when no shader is open', () => {
      set({ record: null });
      expect(status.saveHint()).toBe('Open a shader before saving');
    });
  });

  describe('errorCount', () => {
    it('counts compile and config errors together', () => {
      store.diagnostics.set([error('fragment'), error('config')]);
      expect(status.errorCount()).toBe(2);
    });

    it('ignores warnings', () => {
      store.diagnostics.set([error('fragment'), warning()]);
      expect(status.errorCount()).toBe(1);
    });

    it('pluralises its hint', () => {
      store.diagnostics.set([error('fragment')]);
      expect(status.errorHint()).toBe('1 error — open the editor to see it');

      store.diagnostics.set([error('fragment'), error('vertex')]);
      expect(status.errorHint()).toBe('2 errors — open the editor to see them');
    });
  });
});
