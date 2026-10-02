import {
  Injectable,
  InjectionToken,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';

import {
  isPluginCompatible,
  parsePluginPackage,
  type PluginPackage,
} from '@shadergrove/shared/plugin';
import { APP_VERSION } from '@shadergrove/shared/version';
import { AuthService } from '../auth/auth.service';
import { DesktopPlatform } from '../desktop/desktop-platform';
import { PluginHost } from './plugin-host';
import {
  DesktopPluginStore,
  IndexedDbPluginStore,
  NoPluginStore,
  type PluginStore,
  type StoredPlugin,
} from './plugin-store';

/** The store for one profile. Replaced in tests. */
export const PLUGIN_STORE = new InjectionToken<(profile: string) => PluginStore>('PLUGIN_STORE', {
  providedIn: 'root',
  factory: () => {
    const desktop = inject(DesktopPlatform);
    return (profile: string) => {
      if (desktop.available) return new DesktopPluginStore();
      if (typeof indexedDB === 'undefined') return new NoPluginStore();
      return new IndexedDbPluginStore(`shadergrove-plugins:${profile}`);
    };
  },
});

/** What a package file holds, before anything is installed. */
export type PluginReview =
  | {
      ok: true;
      plugin: PluginPackage;
      text: string;
      compatible: boolean;
      replaces: string | null;
      /** The profile it was read for: it installs there or nowhere. */
      profile: string | null;
    }
  | { ok: false; errors: string[] };

export interface InstalledPlugin {
  id: string;
  stored: StoredPlugin;
  /** `null` when the stored text no longer validates. */
  plugin: PluginPackage | null;
  /** Why it cannot run, if it cannot: invalid on disk, or not for this app version. */
  problem: string | null;
  /** Switched on, and nothing stops it running. */
  active: boolean;
}

/**
 * The locally installed plugins of the current profile.
 *
 * Installing is explicit and leaves the package off; the user switches it on.
 * Every load revalidates what was stored — a file corrupted on disk, or a
 * package for another app version, comes back inactive with the reason — and a
 * profile change (signing in or out on the web) reloads from that profile's own
 * store, so nothing installed under one account runs under another.
 *
 * Removing a package never touches a shader: an effect taken from it was copied.
 */
@Injectable({ providedIn: 'root' })
export class PluginInstallations {
  private readonly storeFor = inject(PLUGIN_STORE);
  private readonly auth = inject(AuthService);

  /**
   * The web's partition key, or `null` while the session is still being
   * resolved: until then nothing is loaded, rather than show — and offer to run —
   * the anonymous profile's plugins to someone about to turn out signed in. The
   * desktop app has one profile, its user data.
   */
  readonly profile = computed(() =>
    this.auth.status() === 'loading' ? null : (this.auth.user()?.id ?? 'anonymous'),
  );

  private readonly pluginsSignal = signal<InstalledPlugin[]>([]);
  readonly plugins = this.pluginsSignal.asReadonly();
  readonly loading = signal(true);

  private store: PluginStore = new NoPluginStore();
  private loads = 0;

  constructor() {
    effect(() => {
      const profile = this.profile();
      untracked(() => void this.switchTo(profile));
    });
  }

  /** Reads a package file without installing anything. */
  review(bytes: Uint8Array): PluginReview {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { ok: false, errors: ['The file is not UTF-8 text'] };
    }
    const parsed = parsePluginPackage(text);
    if (!parsed.ok) return parsed;
    const existing = this.find(parsed.value.manifest.id);
    return {
      ok: true,
      plugin: parsed.value,
      text,
      compatible: isPluginCompatible(parsed.value.manifest, APP_VERSION),
      replaces: existing?.plugin?.manifest.version ?? (existing ? '?' : null),
      profile: this.profile(),
    };
  }

  /**
   * Installs a reviewed package, switched off. A newer file of an installed id
   * replaces it — that is how a local update is done — and keeps it off too.
   */
  async install(review: Extract<PluginReview, { ok: true }>): Promise<void> {
    if (!review.compatible) throw new Error('This package is not made for this version of the app');
    if (review.profile === null || review.profile !== this.profile()) {
      throw new Error('The account changed since this package was picked; pick it again');
    }
    await this.store.put({
      id: review.plugin.manifest.id,
      text: review.text,
      enabled: false,
      installedAt: new Date().toISOString(),
    });
    await this.reload();
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const installed = this.find(id);
    if (!installed) return;
    if (enabled && installed.problem) throw new Error(installed.problem);
    await this.store.put({ ...installed.stored, enabled });
    await this.reload();
  }

  async remove(id: string): Promise<void> {
    await this.store.remove(id);
    await this.reload();
  }

  /** A host for an active plugin's importers and exporters; `null` for anything else. */
  host(id: string): PluginHost | null {
    const installed = this.find(id);
    return installed?.active && installed.plugin ? new PluginHost(installed.plugin) : null;
  }

  find(id: string): InstalledPlugin | undefined {
    return this.pluginsSignal().find((installed) => installed.id === id);
  }

  private async switchTo(profile: string | null): Promise<void> {
    this.pluginsSignal.set([]);
    if (profile === null) {
      // Any load still in flight belongs to a profile that is no longer current.
      this.loads++;
      this.store = new NoPluginStore();
      this.loading.set(true);
      return;
    }
    this.store = this.storeFor(profile);
    await this.reload();
  }

  private async reload(): Promise<void> {
    const load = ++this.loads;
    const store = this.store;
    this.loading.set(true);
    try {
      const stored = await store.list();
      // A newer load — another profile, another change — has the last word.
      if (load !== this.loads) return;
      this.pluginsSignal.set(stored.map(toInstalled).sort((a, b) => a.id.localeCompare(b.id)));
    } finally {
      if (load === this.loads) this.loading.set(false);
    }
  }
}

function toInstalled(stored: StoredPlugin): InstalledPlugin {
  const parsed = parsePluginPackage(stored.text);
  if (!parsed.ok) {
    return {
      id: stored.id,
      stored,
      plugin: null,
      problem: `No longer a valid package: ${parsed.errors[0]}`,
      active: false,
    };
  }
  const compatible = isPluginCompatible(parsed.value.manifest, APP_VERSION);
  const problem = compatible
    ? null
    : `Made for app versions ${parsed.value.manifest.appVersionRange}, not ${APP_VERSION}`;
  if (parsed.value.manifest.id !== stored.id) {
    return {
      id: stored.id,
      stored,
      plugin: null,
      problem: 'Stored under another id',
      active: false,
    };
  }
  return {
    id: stored.id,
    stored,
    plugin: parsed.value,
    problem,
    active: stored.enabled && !problem,
  };
}
