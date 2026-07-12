import { isPlatformBrowser } from '@angular/common';
import { DOCUMENT, Injectable, PLATFORM_ID, inject } from '@angular/core';

import type { RenderSettings } from '../../shared/model';
import type { ShaderDraft } from './shader-store';

const STORAGE_KEY = 'shader-studio.recovered-drafts';
const STORAGE_VERSION = 1;

export interface RecoveredDraft extends ShaderDraft {
  shaderId: string;
  baselineUpdatedAt: string;
  draftUpdatedAt: string;
}

interface DraftDocument {
  version: typeof STORAGE_VERSION;
  drafts: Record<string, RecoveredDraft>;
}

@Injectable({ providedIn: 'root' })
export class DraftRecovery {
  private readonly document = inject(DOCUMENT);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private warned = false;
  onWarning: (() => void) | null = null;

  get(shaderId: string): RecoveredDraft | null {
    const document = this.read();
    const value = document.drafts[shaderId];
    if (!value || !this.valid(value, shaderId)) {
      if (value) this.remove(shaderId);
      return null;
    }
    return structuredClone(value);
  }

  put(shaderId: string, baselineUpdatedAt: string, draft: ShaderDraft): void {
    const document = this.read();
    document.drafts[shaderId] = {
      shaderId,
      baselineUpdatedAt,
      draftUpdatedAt: new Date().toISOString(),
      fragment: draft.fragment,
      vertex: draft.vertex,
      controlsText: draft.controlsText,
      render: structuredClone(draft.render),
    };
    this.write(document);
  }

  remove(shaderId: string): void {
    const document = this.read();
    if (!(shaderId in document.drafts)) return;
    delete document.drafts[shaderId];
    this.write(document);
  }

  private get storage(): Storage | null {
    if (!this.browser) return null;
    try { return this.document.defaultView?.localStorage ?? null; } catch { return null; }
  }

  private empty(): DraftDocument {
    return { version: STORAGE_VERSION, drafts: {} };
  }

  private read(): DraftDocument {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (!raw) return this.empty();
      const value = JSON.parse(raw) as Partial<DraftDocument>;
      if (value.version !== STORAGE_VERSION || !value.drafts || typeof value.drafts !== 'object') {
        this.storage?.removeItem(STORAGE_KEY);
        return this.empty();
      }
      return { version: STORAGE_VERSION, drafts: { ...value.drafts } };
    } catch {
      try { this.storage?.removeItem(STORAGE_KEY); } catch { /* unavailable storage */ }
      return this.empty();
    }
  }

  private write(value: DraftDocument): void {
    if (!this.browser) return;
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(value)); }
    catch {
      if (!this.warned) { this.warned = true; this.onWarning?.(); }
    }
  }

  private valid(value: unknown, shaderId: string): value is RecoveredDraft {
    if (!value || typeof value !== 'object') return false;
    const draft = value as Partial<RecoveredDraft>;
    return draft.shaderId === shaderId && typeof draft.baselineUpdatedAt === 'string' &&
      typeof draft.draftUpdatedAt === 'string' && typeof draft.fragment === 'string' &&
      typeof draft.vertex === 'string' && typeof draft.controlsText === 'string' &&
      this.validRender(draft.render);
  }

  private validRender(value: unknown): value is RenderSettings {
    if (!value || typeof value !== 'object') return false;
    const bloom = (value as Partial<RenderSettings>).bloom;
    return !!bloom && typeof bloom.enabled === 'boolean' &&
      [bloom.strength, bloom.radius, bloom.threshold].every(
        (entry) => typeof entry === 'number' && Number.isFinite(entry),
      );
  }
}
