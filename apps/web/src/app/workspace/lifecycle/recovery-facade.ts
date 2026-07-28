import { isPlatformServer } from '@angular/common';
import { Injectable, PLATFORM_ID, effect, inject } from '@angular/core';

import type { ShaderRecord } from '@shader-studio/shared/model';
import {
  imagePass,
  setPassSource,
  setVertexSource,
  type ShaderProject,
} from '@shader-studio/shared/project';
import { ShaderApi } from '../../api/shader-api';
import { OutputLog } from '../../ui/bottom-panel/output-log';
import { DraftRecovery, type RecoveredDraft } from '../draft-recovery';
import { ProjectPersistence } from '../project-persistence';
import { DocumentState } from '../state/document-state';
import { ProjectMutations } from '../state/project-mutations';

/**
 * How long the draft has to stop changing before it is mirrored to storage.
 *
 * Long enough that typing does not write to `localStorage` on every keystroke,
 * short enough that a crash loses at most a third of a second of work.
 */
const MIRROR_DELAY_MS = 350;

/**
 * What a record's project turned out to be, and whether the browser is still
 * holding the only copy of part of it.
 */
export interface AdoptionPlan {
  /** The project to adopt: the record's own, or a pre-upgrade local one reconciled onto it. */
  project: ShaderProject;
  /** True when that project came from `localStorage` and still has to reach the server. */
  migrate: boolean;
}

/**
 * Everything the workspace does with the browser's own copies of a shader.
 *
 * Two quite different stores hide behind one owner, because the rest of the
 * workspace should not have to know that there are two:
 *
 *  - `DraftRecovery` holds what was *not* saved — the whole project, buffers,
 *    files and wiring included — so that a reload the user did not choose gives
 *    the work back.
 *  - `ProjectPersistence` holds what a *pre-upgrade* browser saved back when the
 *    server's record was one fragment and one vertex. Nothing writes there any
 *    more; this class's job is to reconcile it onto the record, push it to the
 *    server once, and clear it.
 *
 * Blurring the two would be a real bug rather than an untidiness: persisting the
 * live draft as though it were saved makes every unsaved edit look saved the
 * moment the page is reloaded.
 *
 * It writes document state only through `DocumentState`'s semantic transitions —
 * `restoreDraft`, `commitMigratedProject` — and never installs a record itself.
 * Installing a record is `SelectionLifecycle.adopt`'s job, and this class is
 * called from either side of it: `planAdoption` before, `completeAdoption`
 * after.
 */
@Injectable({ providedIn: 'root' })
export class RecoveryFacade {
  private readonly api = inject(ShaderApi);
  private readonly drafts = inject(DraftRecovery);
  private readonly projects = inject(ProjectPersistence);
  private readonly documentState = inject(DocumentState);
  private readonly mutations = inject(ProjectMutations);
  private readonly outputLog = inject(OutputLog);
  private readonly isServer = isPlatformServer(inject(PLATFORM_ID));

  /**
   * Ids currently being pushed to the server, so a second adoption before the
   * first push resolves cannot fire a duplicate write.
   */
  private readonly migrating = new Set<string>();

  constructor() {
    this.drafts.onWarning = () =>
      this.documentState.notify(
        'Local draft recovery is unavailable in this browser session',
        true,
      );

    this.projects.onWarning = () =>
      this.documentState.notify(
        'Local storage is full, so buffers and files may not survive a reload',
        true,
      );

    // A reload is not always something the user chose, so the draft is mirrored
    // to storage while it is dirty and removed again the moment it is not.
    // Debounced rather than immediate: this runs on every keystroke.
    effect((onCleanup) => {
      const record = this.documentState.record();
      const draft = this.documentState.draft();
      const dirty = this.documentState.dirty();
      if (!record || !draft) return;

      const timer = setTimeout(() => {
        if (dirty) this.drafts.put(record.id, record.updatedAt, draft);
        else this.drafts.remove(record.id);
      }, MIRROR_DELAY_MS);
      onCleanup(() => clearTimeout(timer));
    });
  }

  // --- Adoption -------------------------------------------------------------

  /**
   * The project behind a record, decided before anything is installed.
   *
   * The server now always returns one — `record.project`, real or synthesized
   * via `migrateLegacyProject` for a shader that predates projects — so the
   * plain case is simply reading it off the record. The one wrinkle is a browser
   * that still has a *pre-upgrade* `localStorage` entry for this shader, back
   * when the project lived only there: that entry is reconciled onto the record
   * the same way it always was — the record wins for the Image source and the
   * vertex shader when its `updatedAt` has moved on since the entry was last
   * saved, and the passes/files are kept either way — and `migrate` says the
   * result still has to reach the server.
   *
   * On the server there is no browser storage to consult, and consulting it
   * would render a different shader than the client is about to hydrate.
   */
  planAdoption(record: ShaderRecord): AdoptionPlan {
    if (this.isServer) return { project: record.project, migrate: false };

    const stored = this.projects.load(record.id, record.fragment, record.vertex);
    if (!stored) return { project: record.project, migrate: false };

    if (stored.baselineUpdatedAt === record.updatedAt) {
      return { project: stored.project, migrate: true };
    }

    const image = imagePass(stored.project);
    const project = setVertexSource(
      setPassSource(stored.project, image.id, record.fragment),
      record.vertex,
    );
    return { project, migrate: true };
  }

  /**
   * The other half of adoption, once the record is installed: put back an
   * unsaved draft belonging to it, and push a pre-upgrade local project to the
   * server.
   *
   * A recovered draft whose baseline still matches the record is restored
   * without asking — it is unambiguously the same document, one reload later.
   * One whose baseline has moved on is parked in `staleRecovery` instead, for
   * the user to resolve: the shader changed underneath the draft, and silently
   * reinstating it could undo an import or another tab's save.
   *
   * The migration is fired after the synchronous state above, so the UI never
   * waits on it.
   */
  completeAdoption(record: ShaderRecord, plan: AdoptionPlan): void {
    const recovered = this.isServer ? null : this.drafts.get(record.id);
    if (recovered?.baselineUpdatedAt === record.updatedAt) this.restore(recovered);
    else this.documentState.staleRecovery.set(recovered);

    if (plan.migrate) void this.migrateStoredProject(record.id, plan.project);
  }

  // --- Resolution -----------------------------------------------------------

  /**
   * The answer to the recovery dialog. Restoring is refused if the user has
   * moved to a different shader in the meantime — the draft belongs to the one
   * it was taken from, and pasting it over another document would be a fresh
   * disaster rather than a recovery. Either way the stale copy is resolved: it
   * is put back, or it is dropped.
   */
  resolve(restore: boolean): void {
    const recovered = this.documentState.staleRecovery();
    if (!recovered) return;

    if (restore && recovered.shaderId === this.documentState.selectedId()) this.restore(recovered);
    else this.drafts.remove(recovered.shaderId);

    this.documentState.staleRecovery.set(null);
  }

  /**
   * Write the current draft out now rather than in `MIRROR_DELAY_MS` — what the
   * page does on its way out, when there may be no next tick.
   *
   * Only a *dirty* draft is written. A clean one is what the server already
   * holds, and storing it would be indistinguishable from unsaved work on the
   * next load.
   */
  flush(): void {
    const record = this.documentState.record();
    const draft = this.documentState.draft();
    if (record && draft && this.documentState.dirty()) {
      this.drafts.put(record.id, record.updatedAt, draft);
    }
  }

  /**
   * Drop the recovery copy for a shader: it has been saved, or its draft has
   * been discarded, and either way there is nothing left to recover.
   */
  forget(shaderId: string): void {
    this.drafts.remove(shaderId);
  }

  /**
   * Put a recovered draft back over the one adoption just built.
   *
   * The controls text goes through `ProjectMutations` rather than straight into
   * the draft, because the schema it carries has to be re-projected onto the
   * live params and re-validated into the diagnostics — a restore that skipped
   * that would come back with the previous shader's uniforms.
   */
  private restore(recovered: RecoveredDraft): void {
    this.documentState.restoreDraft(recovered);
    this.mutations.setControlsText(recovered.controlsText);
  }

  // --- Legacy migration -----------------------------------------------------

  /**
   * Push a pre-upgrade `localStorage` project to the server, once, and only
   * clear the local copy once the server has confirmed it holds it — losing
   * nothing if the write fails partway (offline, a full disk): the next time
   * this shader loads, `planAdoption` finds the same entry and tries again.
   *
   * Best-effort and quiet on failure: this is background reconciliation, not a
   * user action, and the shader keeps working from the local copy either way.
   * It goes to the Output panel rather than to a notice for exactly that reason.
   */
  private async migrateStoredProject(shaderId: string, project: ShaderProject): Promise<void> {
    if (this.migrating.has(shaderId)) return;
    this.migrating.add(shaderId);

    try {
      const updated = await this.api.update(shaderId, { project });
      // The user may have moved on, or typed throughout: only the record and the
      // baseline move, and only while this is still the open shader.
      if (this.documentState.selectedId() === shaderId) {
        this.documentState.commitMigratedProject(updated, project);
      }
      this.projects.remove(shaderId);
    } catch (error) {
      const message = `Could not migrate the local project for "${shaderId}": ${String(error)}`;
      console.warn(`[store] could not migrate the local project for "${shaderId}"`, error);
      this.outputLog.warning('workspace', message);
    } finally {
      this.migrating.delete(shaderId);
    }
  }
}
