import { isPlatformBrowser } from '@angular/common';
import { DOCUMENT, Injectable, PLATFORM_ID, inject } from '@angular/core';

import { sanitizeProject, type ShaderProject } from '@shader-studio/shared/project';

/**
 * Where a shader's passes and files live between sessions.
 *
 * The server's record of a shader is still one fragment and one vertex — that is
 * what every existing shader, every export bundle and every desktop install
 * already contains, and breaking it would strand all of them. So the *extra*
 * structure a project has over a record — its buffers, its Common pass, its
 * files, its channel wiring — is kept here, in the browser, keyed by shader id.
 * The Image pass's source and the vertex shader stay in the record, which is
 * what keeps a project and a plain old shader the same thing when seen from the
 * server, an export, or an older build of this app.
 *
 * That split is also what makes the legacy story trivial rather than a
 * migration: a shader with nothing stored here is not broken or out of date, it
 * is simply a project with one pass, and `sanitizeProject` builds exactly that
 * from the record it already has.
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

  save(shaderId: string, baselineUpdatedAt: string, project: ShaderProject): void {
    const document = this.read();
    document.projects[shaderId] = {
      shaderId,
      baselineUpdatedAt,
      project: structuredClone(project),
    };
    this.write(document);
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
      // A full quota is the realistic case: a project is a lot bigger than a set
      // of preferences. Say so once — silently losing the buffers on the next
      // reload would be far worse than a warning nobody reads.
      if (!this.warned) {
        this.warned = true;
        this.onWarning?.();
      }
    }
  }
}
