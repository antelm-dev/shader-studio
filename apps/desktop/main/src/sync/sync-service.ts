import type { ShaderLibrary } from '@shader-studio/backend/library';
import type { SyncChangedEvent, SyncStatus } from '@shader-studio/desktop-api/contracts';
import type {
  ImportResult,
  ShaderPayload,
  ShaderRecord,
  ShaderSummary,
} from '@shader-studio/shared/model';
import {
  buildShaderBundle,
  LIMITS,
  mimeFromExt,
  parseBundle,
} from '@shader-studio/shared/validate';
import type { AccountSession, AccountState } from '../account/account-session';

// --- C5 -------------------------------------------------------------------

export interface SyncLink {
  remoteId: string;
  remoteRevision: number;
  localRevision: number;
  /** The local `thumbnail.updatedAt` at the last sync. */
  localThumbnail: string | null;
}

type Links = Record<string, SyncLink>;

/** Account ids that have a `sync_links:<id>` entry, so other accounts' links can be found. */
const ACCOUNTS_KEY = 'sync_accounts';
const linksKey = (userId: string) => `sync_links:${userId}`;
const CONFLICT_SUFFIX = ' (conflict)';
const JSON_HEADERS = { 'content-type': 'application/json' };
const SAVE_DEBOUNCE_MS = 2_000;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

/** Ends a run: the account needs signing in again, or the server is unreachable. */
class Stop extends Error {
  constructor(readonly reason: 'reauth' | 'offline') {
    super(reason);
  }
}

function isDirty(summary: ShaderSummary, link: SyncLink): boolean {
  return (
    summary.revision > link.localRevision ||
    (summary.thumbnail?.updatedAt ?? null) !== link.localThumbnail
  );
}

async function expectOk(response: Response): Promise<Response> {
  if (!response.ok) throw new Error(`The account server answered ${response.status}`);
  return response;
}

/**
 * Pushes linked local shaders to the signed-in account (milestone 1: no pull).
 * The local library stays the source of truth; every failure path leaves it
 * untouched except "keep both", which first saves the local edits as a copy.
 */
export class SyncService {
  private chain: Promise<void> = Promise.resolve();
  private queuedRun: Promise<void> | null = null;
  private syncing: string | null = null;
  private progress: SyncChangedEvent['progress'] = null;
  private readonly resolved = new Set<string>();
  private readonly failed = new Set<string>();
  private userId: string | undefined;
  private retryDelay = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly library: ShaderLibrary,
    private readonly account: AccountSession,
    private readonly emit: (event: SyncChangedEvent) => void,
  ) {
    this.userId = account.state().user?.id;
    this.unsubscribe = account.onChange((state) => {
      if (state.user?.id !== this.userId) {
        this.userId = state.user?.id;
        this.resolved.clear();
        this.failed.clear();
      }
      if (state.status === 'signed-in') void this.run();
      else this.publish();
    });
  }

  /**
   * Pushes every dirty link. Runs never overlap: a trigger while one is waiting
   * joins it, a trigger while one is going queues exactly one more.
   */
  run(): Promise<void> {
    return (this.queuedRun ??= this.enqueue(() => {
      this.queuedRun = null;
      return this.pushDirty();
    }));
  }

  /** Links the given local shaders to the account. Templates and linked shaders are skipped. */
  upload(ids: string[]): Promise<void> {
    return this.enqueue(() => this.uploadNow(ids));
  }

  uploadAll(): Promise<void> {
    return this.enqueue(async () =>
      this.uploadNow((await this.library.list()).map((summary) => summary.id)),
    );
  }

  /** A local write happened: show `pending` now, push shortly after. */
  changed(): void {
    this.publish();
    if (this.account.state().status !== 'signed-in') return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.run(), SAVE_DEBOUNCE_MS);
  }

  dispose(): void {
    clearTimeout(this.saveTimer);
    clearTimeout(this.retryTimer);
    this.unsubscribe();
  }

  async snapshot(): Promise<SyncChangedEvent> {
    const state = this.account.state();
    const userId = state.user?.id;
    const statuses: Record<string, SyncStatus> = {};
    if (userId && (state.status === 'signed-in' || state.status === 'reauth-required')) {
      const links = await this.readLinks(userId);
      const others = await this.otherLinked(userId);
      for (const summary of await this.library.list()) {
        if (summary.kind === 'template') continue;
        statuses[summary.id] = this.statusOf(summary, links[summary.id], others, state);
      }
    }
    return { statuses, progress: this.progress };
  }

  private statusOf(
    summary: ShaderSummary,
    link: SyncLink | undefined,
    others: Set<string>,
    state: AccountState,
  ): SyncStatus {
    if (summary.id === this.syncing) return 'syncing';
    if (this.failed.has(summary.id)) return 'error';
    if (!link) return others.has(summary.id) ? 'other-account' : 'local-only';
    if (state.status === 'reauth-required') return 'reauth-required';
    if (isDirty(summary, link)) return 'pending';
    return this.resolved.has(summary.id) ? 'conflict-resolved' : 'synced';
  }

  // --- Runs ------------------------------------------------------------------

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.chain.then(work).catch((error: unknown) => {
      console.error('[sync] run failed', error);
    });
    this.chain = next;
    return next;
  }

  private signedInUser(): string | undefined {
    const state = this.account.state();
    return state.status === 'signed-in' ? state.user?.id : undefined;
  }

  private async pushDirty(): Promise<void> {
    const userId = this.signedInUser();
    if (!userId) return this.publish();
    const links = await this.readLinks(userId);
    const summaries = new Map((await this.library.list()).map((s) => [s.id, s]));
    const dirty = Object.keys(links).filter((id) => {
      const summary = summaries.get(id);
      return summary && summary.kind !== 'template' && isDirty(summary, links[id]);
    });
    await this.batch(dirty, (id) => this.push(userId, id, links));
  }

  private async uploadNow(ids: string[]): Promise<void> {
    const userId = this.signedInUser();
    if (!userId) return this.publish();
    const links = await this.readLinks(userId);
    const others = await this.otherLinked(userId);
    const summaries = new Map((await this.library.list()).map((s) => [s.id, s]));
    const todo = ids.filter(
      (id) => summaries.get(id)?.kind === 'shader' && !links[id] && !others.has(id),
    );
    await this.batch(todo, async (id) => {
      // Revision first: an edit landing during the export is pushed next run.
      const { revision } = await this.library.read(id);
      const payload = await this.library.exportOne(id);
      const response = await expectOk(
        await this.call('/api/import', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ bundle: buildShaderBundle(payload), mode: 'rename' }),
        }),
      );
      const { imported } = (await response.json()) as ImportResult;
      links[id] = {
        remoteId: imported[0].id,
        remoteRevision: 1,
        localRevision: revision,
        localThumbnail: payload.thumbnail?.updatedAt ?? null,
      };
      await this.writeLinks(userId, links);
    });
  }

  /** One shader at a time, with progress. 401 or no network stops the batch. */
  private async batch(ids: string[], work: (id: string) => Promise<void>): Promise<void> {
    let stop: Stop | undefined;
    if (ids.length > 0) {
      this.progress = { done: 0, total: ids.length };
      for (const id of ids) {
        this.syncing = id;
        this.publish();
        try {
          await work(id);
          this.failed.delete(id);
        } catch (error) {
          if (error instanceof Stop) {
            stop = error;
            break;
          }
          console.warn(`[sync] "${id}" failed`, error);
          this.failed.add(id);
        }
        this.progress = { done: this.progress.done + 1, total: ids.length };
      }
      this.syncing = null;
      this.progress = null;
    }
    this.publish();

    clearTimeout(this.retryTimer);
    if (stop?.reason === 'offline') {
      this.retryDelay = Math.min(Math.max(this.retryDelay * 2, RETRY_MIN_MS), RETRY_MAX_MS);
      this.retryTimer = setTimeout(() => void this.run(), this.retryDelay);
    } else {
      this.retryDelay = 0;
    }
  }

  private async call(path: string, init?: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.account.fetch(path, init);
    } catch {
      throw new Stop('offline');
    }
    if (response.status === 401) throw new Stop('reauth');
    return response;
  }

  private async push(userId: string, id: string, links: Links): Promise<void> {
    const link = links[id];
    const base = `/api/shaders/${encodeURIComponent(link.remoteId)}`;
    const { revision } = await this.library.read(id);
    const payload = await this.library.exportOne(id);

    if (revision > link.localRevision) {
      const response = await this.call(`${base}/bundle`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          bundle: buildShaderBundle(payload),
          expectedRevision: link.remoteRevision,
        }),
      });
      if (response.status === 409) return this.keepBoth(userId, id, links, payload, revision);
      if (response.status === 404) return this.unlink(userId, id, links);
      const { shader } = (await (await expectOk(response)).json()) as { shader: ShaderRecord };
      links[id] = { ...link, remoteRevision: shader.revision, localRevision: revision };
      await this.writeLinks(userId, links);
      this.resolved.delete(id);
    }

    // `PUT …/bundle` ignores thumbnails; they travel on their own.
    const thumbnail = payload.thumbnail;
    if ((thumbnail?.updatedAt ?? null) === links[id].localThumbnail) return;
    if (thumbnail?.data) {
      const response = await this.call(`${base}/thumbnail`, {
        method: 'PUT',
        headers: { 'content-type': mimeFromExt(thumbnail.ext) },
        body: new Uint8Array(Buffer.from(thumbnail.data, 'base64')),
      });
      if (response.status === 404) return this.unlink(userId, id, links);
      await expectOk(response);
    }
    links[id] = { ...links[id], localThumbnail: thumbnail?.updatedAt ?? null };
    await this.writeLinks(userId, links);
  }

  /**
   * 409: the account moved on. The local edits go to an unlinked copy first,
   * then the linked slot takes the account version — nothing is lost if any
   * step fails, at worst the next run makes another copy.
   */
  private async keepBoth(
    userId: string,
    id: string,
    links: Links,
    local: ShaderPayload,
    localRevision: number,
  ): Promise<void> {
    const link = links[id];
    const base = `/api/shaders/${encodeURIComponent(link.remoteId)}`;
    // Revision before content: if the account moves again in between, the next
    // push conflicts again instead of overwriting what we never saw.
    const current = await this.call(base);
    if (current.status === 404) return this.unlink(userId, id, links);
    const { shader: remote } = (await (await expectOk(current)).json()) as {
      shader: ShaderRecord;
    };
    const exported = await this.call(`${base}/export`);
    if (exported.status === 404) return this.unlink(userId, id, links);
    const parsed = parseBundle(await (await expectOk(exported)).json());
    if (!parsed.ok) throw new Error('The account version could not be read');
    const [account] = parsed.value;

    const name = local.name.slice(0, LIMITS.nameLength - CONFLICT_SUFFIX.length);
    await this.library.importPayloads([{ ...local, name: name + CONFLICT_SUFFIX }], 'rename');
    let record = await this.library.replaceFromPayload(id, account, localRevision);
    if (account.thumbnail?.data) {
      record = await this.library.setThumbnail(id, {
        ext: account.thumbnail.ext,
        bytes: Buffer.from(account.thumbnail.data, 'base64'),
      });
    }
    links[id] = {
      remoteId: link.remoteId,
      remoteRevision: remote.revision,
      localRevision: record.revision,
      localThumbnail: record.thumbnail?.updatedAt ?? null,
    };
    await this.writeLinks(userId, links);
    this.resolved.add(id);
  }

  /** 404: deleted on the account. The local shader stays, unlinked. */
  private async unlink(userId: string, id: string, links: Links): Promise<void> {
    delete links[id];
    this.resolved.delete(id);
    await this.writeLinks(userId, links);
  }

  // --- Links -----------------------------------------------------------------

  private publish(): void {
    void this.snapshot().then(this.emit, (error: unknown) =>
      console.error('[sync] status failed', error),
    );
  }

  private async readLinks(userId: string): Promise<Links> {
    return JSON.parse((await this.library.getMeta(linksKey(userId))) ?? '{}') as Links;
  }

  // ponytail: the whole JSON map is rewritten on each change; a `sync_links` table if libraries grow large.
  private async writeLinks(userId: string, links: Links): Promise<void> {
    await this.library.setMeta(linksKey(userId), JSON.stringify(links));
    const accounts = await this.accounts();
    if (!accounts.includes(userId)) {
      await this.library.setMeta(ACCOUNTS_KEY, JSON.stringify([...accounts, userId]));
    }
  }

  private async accounts(): Promise<string[]> {
    return JSON.parse((await this.library.getMeta(ACCOUNTS_KEY)) ?? '[]') as string[];
  }

  /** Local ids linked to any account but this one. */
  private async otherLinked(userId: string): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const other of await this.accounts()) {
      if (other !== userId) for (const id of Object.keys(await this.readLinks(other))) ids.add(id);
    }
    return ids;
  }
}

const WRITES = new Set([
  'create',
  'update',
  'duplicate',
  'remove',
  'savePreset',
  'deletePreset',
  'importPayloads',
  'setTexture',
  'clearTexture',
  'setThumbnail',
]);

/** The library as the shader IPC sees it: every successful write also calls `onWrite`. */
export function notifyingWrites(library: ShaderLibrary, onWrite: () => void): ShaderLibrary {
  return new Proxy(library, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== 'function' || !WRITES.has(String(key))) return value;
      return async (...args: unknown[]) => {
        const result: unknown = await value.apply(target, args);
        onWrite();
        return result;
      };
    },
  });
}
