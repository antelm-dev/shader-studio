import { isPlatformBrowser } from '@angular/common';
import { DOCUMENT, Injectable, PLATFORM_ID, inject } from '@angular/core';

import { sanitizeProject, type ShaderProject } from '@shader-studio/shared/project';

/**
 * Where a pre-upgrade shader's passes and files live until they are migrated.
 *
 * A shader's project — its buffers, its Common pass, its files, its channel
 * wiring — used to live only here, in the browser, because the server's record
 * held nothing but one fragment and one vertex. It is now a first-class part of
 * the record (`ShaderRecord.project`, persisted server-side as `project.json`),
 * so nothing writes here any more: `ShaderStore.save()` sends the whole project
 * to the server, and `ShaderStore.migrateStoredProject` pushes whatever a
 * browser still has stored under an id here, then clears it — see
 * `ShaderStore.projectFor`. This class's remaining job is `load`/`remove`,
 * exactly as much as that one-time migration needs.
 *
 * Deliberately the same shape, and the same defensive reading, as
 * `DraftRecovery` next door: storage is not a trusted input. It outlives the
 * code that wrote it, it can be hand-edited, and a project that is *almost*
 * right must not take the app down with it.
 */

const STORAGE_KEY = 'shader-studio.projects';
const STORAGE_VERSION = 1;

interface StoredProject {
  shaderId: string;
  /**
   * The `updatedAt` of the record this project was last in step with.
   *
   * When it no longer matches, the shader has changed underneath us — an import,
   * an edit in another tab, a desktop sync — and the stored Image source is
   * stale. The record wins for what the record owns; see `ShaderStore.adopt`.
   */
  baselineUpdatedAt: string;
  project: ShaderProject;
}

interface ProjectDocument {
  version: typeof STORAGE_VERSION;
  projects: Record<string, StoredProject>;
}

@Injectable({ providedIn: 'root' })
export class ProjectPersistence {
  private readonly document = inject(DOCUMENT);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));

  private warned = false;
  onWarning: (() => void) | null = null;

  /**
   * The stored project for a shader, or `null` if it has never been saved with
   * one — which is the normal state of every shader that predates passes.
   *
   * The record's own sources are passed in as the fallback for every field the
   * stored copy turns out to be missing, so what comes back is always a project
   * that renders *something*, even from rubbish.
   */
  load(
    shaderId: string,
    fallbackFragment: string,
    fallbackVertex: string,
  ): { project: ShaderProject; baselineUpdatedAt: string } | null {
    const stored = this.read().projects[shaderId];
    if (!stored || typeof stored.baselineUpdatedAt !== 'string') return null;

    return {
      project: sanitizeProject(stored.project, fallbackFragment, fallbackVertex),
      baselineUpdatedAt: stored.baselineUpdatedAt,
    };
  }

  remove(shaderId: string): void {
    const document = this.read();
    if (!(shaderId in document.projects)) return;
    delete document.projects[shaderId];
    this.write(document);
  }

  private get storage(): Storage | null {
    if (!this.browser) return null;
    try {
      // Private-browsing modes expose `localStorage` but throw on access.
      return this.document.defaultView?.localStorage ?? null;
    } catch {
      return null;
    }
  }

  private empty(): ProjectDocument {
    return { version: STORAGE_VERSION, projects: {} };
  }

  private read(): ProjectDocument {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (!raw) return this.empty();

      const value = JSON.parse(raw) as Partial<ProjectDocument>;
      if (
        value.version !== STORAGE_VERSION ||
        !value.projects ||
        typeof value.projects !== 'object'
      ) {
        this.storage?.removeItem(STORAGE_KEY);
        return this.empty();
      }

      return { version: STORAGE_VERSION, projects: { ...value.projects } };
    } catch {
      try {
        this.storage?.removeItem(STORAGE_KEY);
      } catch {
        /* unavailable storage */
      }
      return this.empty();
    }
  }

  private write(value: ProjectDocument): void {
    if (!this.browser) return;
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch {
      // `remove` is the only caller left, so this is a shrink — but storage can
      // still be too full to accept even that. Say so once rather than silently
      // leaving a migrated shader's local copy behind forever.
      if (!this.warned) {
        this.warned = true;
        this.onWarning?.();
      }
    }
  }
}
