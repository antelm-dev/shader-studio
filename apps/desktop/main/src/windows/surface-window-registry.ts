/**
 * Live SurfaceId → BrowserWindow registry. Electron window ids are never keys.
 */

import type { BrowserWindow } from 'electron';

import { capabilitiesFor, type SurfaceId, type SurfaceKind } from '@shader-studio/shared/surfaces';

export type SurfaceWindowRole = 'main' | 'satellite';

export interface SurfaceWindowEntry {
  surfaceId: SurfaceId;
  kind: SurfaceKind;
  window: BrowserWindow;
  /** App pathname loaded in this window (no source payloads). */
  path: string;
  role: SurfaceWindowRole;
}

export type RegistryOpenDecision =
  | { ok: true }
  | { ok: false; reason: string; existing?: SurfaceWindowEntry };

export class SurfaceWindowRegistry {
  private readonly byId = new Map<SurfaceId, SurfaceWindowEntry>();
  private readonly byWebContentsId = new Map<number, SurfaceId>();

  get(surfaceId: SurfaceId): SurfaceWindowEntry | undefined {
    return this.byId.get(surfaceId);
  }

  getByWebContentsId(webContentsId: number): SurfaceWindowEntry | undefined {
    const surfaceId = this.byWebContentsId.get(webContentsId);
    return surfaceId ? this.byId.get(surfaceId) : undefined;
  }

  getByWindow(window: BrowserWindow): SurfaceWindowEntry | undefined {
    if (window.isDestroyed()) return undefined;
    return this.getByWebContentsId(window.webContents.id);
  }

  list(): SurfaceWindowEntry[] {
    return [...this.byId.values()];
  }

  listByKind(kind: SurfaceKind): SurfaceWindowEntry[] {
    return this.list().filter((entry) => entry.kind === kind);
  }

  isOpen(surfaceId: SurfaceId): boolean {
    const entry = this.byId.get(surfaceId);
    return Boolean(entry && !entry.window.isDestroyed());
  }

  /**
   * Enforce capability singleton / multiInstance before creating a window.
   * Singleton kinds refuse a second live instance (caller should focus existing).
   */
  canOpen(kind: SurfaceKind, surfaceId: SurfaceId): RegistryOpenDecision {
    const caps = capabilitiesFor(kind);
    const sameId = this.byId.get(surfaceId);
    if (sameId && !sameId.window.isDestroyed()) {
      return { ok: false, reason: 'already-open', existing: sameId };
    }

    if (caps.singleton) {
      const live = this.listByKind(kind).find((e) => !e.window.isDestroyed());
      if (live) {
        return { ok: false, reason: 'singleton-occupied', existing: live };
      }
    }

    if (!caps.multiInstance && !caps.singleton) {
      // Defensive: kinds should declare one of the two. Treat as singleton.
      const live = this.listByKind(kind).find((e) => !e.window.isDestroyed());
      if (live && live.surfaceId !== surfaceId) {
        return { ok: false, reason: 'kind-occupied', existing: live };
      }
    }

    return { ok: true };
  }

  register(entry: SurfaceWindowEntry): void {
    if (entry.window.isDestroyed()) {
      throw new Error(`Cannot register destroyed window for ${entry.surfaceId}`);
    }
    const decision = this.canOpen(entry.kind, entry.surfaceId);
    if (!decision.ok && decision.reason !== 'already-open') {
      throw new Error(`Cannot register surface ${entry.surfaceId}: ${decision.reason}`);
    }
    // Replace any stale or live entry for this SurfaceId.
    if (this.byId.has(entry.surfaceId)) {
      this.unregister(entry.surfaceId);
    }
    this.byId.set(entry.surfaceId, entry);
    this.byWebContentsId.set(entry.window.webContents.id, entry.surfaceId);
  }

  unregister(surfaceId: SurfaceId): SurfaceWindowEntry | undefined {
    const entry = this.byId.get(surfaceId);
    if (!entry) return undefined;
    this.byId.delete(surfaceId);
    if (!entry.window.isDestroyed()) {
      this.byWebContentsId.delete(entry.window.webContents.id);
    } else {
      // Best-effort: drop any stale webContents mapping that still points here.
      for (const [wcId, id] of this.byWebContentsId) {
        if (id === surfaceId) this.byWebContentsId.delete(wcId);
      }
    }
    return entry;
  }

  clear(): SurfaceWindowEntry[] {
    const entries = this.list();
    this.byId.clear();
    this.byWebContentsId.clear();
    return entries;
  }
}
