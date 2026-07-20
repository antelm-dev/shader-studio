import { Injectable, signal } from '@angular/core';

import type { CompileDiagnostic } from '@shader-studio/shared/diagnostic';
import type { CompileOutcome } from './shader-store';

interface CompileWaiter {
  resolve: (outcome: CompileOutcome) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The revision-tracked compile-waiter machine behind `waitForCompile` and
 * `compileNow`: bumped once per draft mutation (`ShaderStore.patchDraft`
 * shares the same `draftRevision` signal instance), resolved once per
 * landed compile. `ShaderStore` still decides *when* to reset it and what
 * diagnostics a finished compile carries — merging in config diagnostics is
 * a document-state concern, not a compilation one — this is just the
 * revision bookkeeping and the waiter queue.
 */
@Injectable({ providedIn: 'root' })
export class CompilationService {
  /**
   * Bumped once by every `patchDraft` call — the single choke point behind
   * every project/controls/render mutation. This is what `apply_shader_patch`
   * checks a `baseRevision` against, and what `waitForCompile` correlates a
   * finished compile back to a specific edit.
   */
  readonly draftRevision = signal(0);

  /** The revision `recordCompileResult` most recently landed. -1 until the first compile. */
  readonly compiledRevision = signal(-1);

  /** Bumped to ask `shader-canvas` to flush its debounce timer immediately instead of waiting ~400ms. */
  readonly immediateCompileRequest = signal(0);

  /**
   * Force a recompile now, rather than when the debounce elapses.
   *
   * The renderer recompiles a pass whose *composed source* changed, which means
   * asking for a recompile of a source nobody touched would be a no-op. So the
   * request is a signal the canvas watches, not a source edit: it says "compile,
   * even though nothing changed", which is what the user means by Ctrl+Enter
   * after the driver has been sulking or a texture has finished loading.
   */
  readonly recompileRequest = signal(0);

  private lastCompileOutcome: CompileOutcome | null = null;
  private readonly waiters = new Map<number, CompileWaiter[]>();

  recompile(): void {
    this.recompileRequest.update((n) => n + 1);
  }

  /**
   * Called once a compile for `revision` has actually landed on the GPU —
   * real completion, not a fixed wait. `diagnostics` is the final, merged
   * list the caller wants attached to this outcome. Resolves every
   * `waitForCompile` call whose revision is now satisfied: a waiter for an
   * older revision is satisfied by a newer compile too, since revisions are
   * cumulative and a later one already reflects everything an earlier one
   * would have.
   */
  recordCompileResult(revision: number, diagnostics: readonly CompileDiagnostic[]): void {
    const outcome: CompileOutcome = { revision, diagnostics };
    this.lastCompileOutcome = outcome;
    this.compiledRevision.set(revision);

    for (const [waitingRevision, waiters] of [...this.waiters]) {
      if (waitingRevision > revision) continue;
      this.waiters.delete(waitingRevision);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(outcome);
      }
    }
  }

  /** Resolves once a compile at or after `revision` has landed, or rejects after `timeoutMs`. */
  waitForCompile(revision: number, timeoutMs = 10_000): Promise<CompileOutcome> {
    if (this.compiledRevision() >= revision && this.lastCompileOutcome) {
      return Promise.resolve(this.lastCompileOutcome);
    }

    return new Promise<CompileOutcome>((resolve, reject) => {
      const waiters = this.waiters.get(revision) ?? [];
      const waiter: CompileWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const list = this.waiters.get(revision);
          if (list) {
            const index = list.indexOf(waiter);
            if (index >= 0) list.splice(index, 1);
            if (list.length === 0) this.waiters.delete(revision);
          }
          reject(new Error(`Timed out waiting for a compile of revision ${revision}`));
        }, timeoutMs),
      };
      waiters.push(waiter);
      this.waiters.set(revision, waiters);
    });
  }

  reset(): void {
    this.draftRevision.set(0);
    this.compiledRevision.set(-1);
    this.lastCompileOutcome = null;

    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('The shader changed before this compile finished.'));
      }
    }
    this.waiters.clear();
  }
}
