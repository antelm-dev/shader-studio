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
  /** The account's `thumbnail.updatedAt` at the last sync; missing on older links: pull it once. */
  remoteThumbnail?: string | null;
}

type Links = Record<string, SyncLink>;
/** One unit of a run: the local id it reports on (none for a new pull), and its work. */
type Task = [id: string | null, work: () => Promise<void>];

/** Account ids that have a `sync_links:<id>` entry, so other accounts' links can be found. */
const ACCOUNTS_KEY = 'sync_accounts';
const linksKey = (userId: string) => `sync_links:${userId}`;
/** Remote ids this computer must never pull. */
const ignoredKey = (userId: string) => `sync_ignored:${userId}`;
const CONFLICT_SUFFIX = ' (conflict)';
const JSON_HEADERS = { 'content-type': 'application/json' };
const SAVE_DEBOUNCE_MS = 2_000;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
const POLL_MS = 60_000;
const FOCUS_MIN_MS = 15_000;

/**
 * Ends a run: the account needs signing in again, the server is unreachable,
 * or the signed-in account is no longer the one the run started for.
 */
class Stop extends Error {
  constructor(readonly reason: 'reauth' | 'offline' | 'switched') {
    super(reason);
  }
}

function isDirty(summary: ShaderSummary | ShaderRecord, link: SyncLink): boolean {
  return (
    summary.revision > link.localRevision ||
    (summary.thumbnail?.updatedAt ?? null) !== link.localThumbnail
  );
}

/** The account moved on since the last sync: content, or a thumbnail (unknown on older links). */
function remoteChanged(summary: ShaderSummary, link: SyncLink): boolean {
  return (
    summary.revision > link.remoteRevision ||
    (summary.thumbnail?.updatedAt ?? null) !== link.remoteThumbnail
  );
}

async function expectOk(response: Response): Promise<Response> {
  if (!response.ok) throw new Error(`The account server answered ${response.status}`);
  return response;
}

/**
 * Keeps linked local shaders and the signed-in account in step: each run reads
 * the account's list, pushes local edits, then pulls the account's. Pulled
 * shaders live in the local scope, like uploaded ones. Every failure path
 * leaves the library untouched except "keep both", which first saves the local
 * edits as a copy; a pull never replaces a local edit.
 */
export class SyncService {
  private chain: Promise<void> = Promise.resolve();
  private queuedRun: Promise<void> | null = null;
  private syncing: string | null = null;
  private progress: SyncChangedEvent['progress'] = null;
  private readonly resolved = new Set<string>();
  private readonly failed = new Set<string>();
  /** Linked ids the last run found in the account's list: only these can be `synced`. */
  private readonly checked = new Set<string>();
  /** Ids whose thumbnail this run pushed: the account's is ours, nothing to pull. */
  private readonly thumbnailsSent = new Set<string>();
  /** Ids a keep-both or a pull replaced since the last event, for the renderer to reload. */
  private replaced: string[] = [];
  private userId: string | undefined;
  private retryDelay = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private lastFocusRun = -Infinity;
  private readonly unsubscribe: () => void;
  private disposed = false;

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
        this.checked.clear();
      }
      this.poll(state);
      if (state.status === 'signed-in') void this.run();
      else this.publish();
    });
    this.poll(account.state());
  }

  /**
   * Reads the account, pushes every dirty link, then pulls. Runs never overlap:
   * a trigger while one is waiting joins it, a trigger while one is going
   * queues exactly one more.
   */
  run(): Promise<void> {
    return (this.queuedRun ??= this.enqueue(() => {
      this.queuedRun = null;
      return this.syncNow();
    }));
  }

  /** The window gained focus: run, at most once every 15 s. */
  focused(): void {
    if (!this.signedInUser() || Date.now() - this.lastFocusRun < FOCUS_MIN_MS) return;
    this.lastFocusRun = Date.now();
    void this.run();
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
    this.disposed = true;
    clearTimeout(this.saveTimer);
    clearTimeout(this.retryTimer);
    clearInterval(this.pollTimer);
    this.unsubscribe();
  }

  /** Runs every minute while signed in. */
  private poll(state: AccountState): void {
    if (state.status !== 'signed-in') {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    } else if (!this.disposed) {
      this.pollTimer ??= setInterval(() => void this.run(), POLL_MS);
    }
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
    // Synced means the last run found it in the account's list.
    if (isDirty(summary, link) || !this.checked.has(summary.id)) return 'pending';
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

  /** One `GET /api/shaders`, dead links dropped, then pushes, then pulls. */
  private async syncNow(): Promise<void> {
    const userId = this.signedInUser();
    if (!userId) return this.publish();
    let remote: ShaderSummary[];
    try {
      const response = await expectOk(await this.call(userId, '/api/shaders'));
      const { shaders } = (await response.json()) as { shaders: ShaderSummary[] };
      remote = shaders.filter((summary) => summary.kind !== 'template');
    } catch (error) {
      if (!(error instanceof Stop)) throw error;
      this.checked.clear();
      return this.batch([], error);
    }
    const remoteIds = new Set(remote.map((summary) => summary.id));
    const summaries = new Map((await this.library.list()).map((s) => [s.id, s]));
    const links = await this.readLinks(userId);
    const ignored = await this.readIgnored(userId);

    // Deleted here without a choice: never pulled back. Deleted on the account: ours stays.
    const gone = Object.keys(links).filter((id) => !summaries.has(id));
    const dropped = Object.keys(links).filter(
      (id) => summaries.has(id) && !remoteIds.has(links[id].remoteId),
    );
    if (gone.length > 0) {
      // Before the links: if that write fails, the next run finds the same links.
      for (const id of gone) ignored.add(links[id].remoteId);
      await this.writeIgnored(userId, ignored);
    }
    if (gone.length + dropped.length > 0) {
      for (const id of [...gone, ...dropped]) {
        delete links[id];
        this.resolved.delete(id);
      }
      await this.writeLinks(userId, links);
    }
    if (this.userId === userId) {
      this.checked.clear();
      for (const id of Object.keys(links)) this.checked.add(id);
    }

    this.thumbnailsSent.clear();
    const tasks = Object.keys(links)
      .filter((id) => {
        const summary = summaries.get(id)!;
        return summary.kind !== 'template' && isDirty(summary, links[id]);
      })
      .map((id): Task => [id, () => this.push(userId, id, links)]);
    const linkedTo = new Map(Object.entries(links).map(([id, link]) => [link.remoteId, id]));
    for (const summary of remote) {
      const id = linkedTo.get(summary.id);
      if (id !== undefined) {
        if (remoteChanged(summary, links[id])) {
          tasks.push([id, () => this.pull(userId, id, summary, links)]);
        }
      } else if (!ignored.has(summary.id)) {
        tasks.push([null, () => this.pullNew(userId, summary, links)]);
      }
    }
    await this.batch(tasks);
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
    await this.batch(todo.map((id): Task => [id, () => this.uploadOne(userId, id, links)]));
  }

  private async uploadOne(userId: string, id: string, links: Links): Promise<void> {
    // Revision first: an edit landing during the export is pushed next run.
    const { revision } = await this.library.read(id);
    const payload = await this.library.exportOne(id);
    const response = await expectOk(
      await this.call(userId, '/api/import', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ bundle: buildShaderBundle(payload), mode: 'rename' }),
      }),
    );
    const { imported } = (await response.json()) as ImportResult;
    // An import keeps the thumbnail's `updatedAt`, so both sides start equal.
    const thumbnail = payload.thumbnail?.updatedAt ?? null;
    links[id] = {
      remoteId: imported[0].id,
      remoteRevision: 1,
      localRevision: revision,
      localThumbnail: thumbnail,
      remoteThumbnail: thumbnail,
    };
    await this.writeLinks(userId, links);
    if (this.userId === userId) this.checked.add(id);
  }

  /** One task at a time, with progress. 401 or no network stops the batch. */
  private async batch(tasks: Task[], stop?: Stop): Promise<void> {
    if (tasks.length > 0) {
      this.progress = { done: 0, total: tasks.length };
      for (const [id, work] of tasks) {
        this.syncing = id;
        this.publish();
        try {
          await work();
          if (id !== null) this.failed.delete(id);
        } catch (error) {
          if (error instanceof Stop) {
            stop = error;
            break;
          }
          console.warn(`[sync] "${id ?? 'new shader'}" failed`, error);
          if (id !== null) this.failed.add(id);
        }
        this.progress = { done: this.progress.done + 1, total: tasks.length };
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

  /**
   * A run belongs to the account it started for. `account.fetch` sends whatever
   * token is current, so every request first checks that this is still that
   * account — synchronously, right before sending — and a run that finds
   * another one stops there. A request already sent for this account keeps its
   * result: it is written to this account's links, never another's.
   */
  private assertAccount(userId: string): void {
    const state = this.account.state();
    if (state.status !== 'signed-in' || state.user?.id !== userId) throw new Stop('switched');
  }

  private async call(userId: string, path: string, init?: RequestInit): Promise<Response> {
    this.assertAccount(userId);
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
      const response = await this.call(userId, `${base}/bundle`, {
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
      const response = await this.call(userId, `${base}/thumbnail`, {
        method: 'PUT',
        headers: { 'content-type': mimeFromExt(thumbnail.ext) },
        body: new Uint8Array(Buffer.from(thumbnail.data, 'base64')),
      });
      if (response.status === 404) return this.unlink(userId, id, links);
      const { shader } = (await (await expectOk(response)).json()) as { shader: ShaderRecord };
      links[id] = { ...links[id], remoteThumbnail: shader.thumbnail?.updatedAt ?? null };
      this.thumbnailsSent.add(id);
    }
    links[id] = { ...links[id], localThumbnail: thumbnail?.updatedAt ?? null };
    await this.writeLinks(userId, links);
  }

  /**
   * The account changed a linked shader this computer has not. The content
   * replace is checked against the revision just read, so a local edit landing
   * meanwhile fails the pull instead of being overwritten.
   */
  private async pull(
    userId: string,
    id: string,
    summary: ShaderSummary,
    links: Links,
  ): Promise<void> {
    const link = links[id];
    // Unlinked by a push this run, or dirty because its push failed: next run.
    if (!link) return;
    const local = await this.library.read(id);
    if (isDirty(local, link)) return;
    const content = summary.revision > link.remoteRevision;
    const thumbnail =
      (summary.thumbnail?.updatedAt ?? null) !== link.remoteThumbnail &&
      !this.thumbnailsSent.has(id);
    if (!content && !thumbnail) return;
    const account = await this.fetchPayload(userId, link.remoteId);
    if (!account) return this.unlink(userId, id, links);

    let record = local;
    if (content) {
      record = await this.library.replaceFromPayload(id, account, local.revision);
      this.replaced.push(id);
      this.resolved.delete(id);
    }
    if (thumbnail) record = await this.applyThumbnail(id, account);
    links[id] = {
      ...link,
      // The list's revision is never newer than the export: at worst the next run pulls again.
      remoteRevision: content ? summary.revision : link.remoteRevision,
      localRevision: record.revision,
      localThumbnail: record.thumbnail?.updatedAt ?? null,
      remoteThumbnail: thumbnail ? (account.thumbnail?.updatedAt ?? null) : link.remoteThumbnail,
    };
    await this.writeLinks(userId, links);
  }

  /** A shader only the account has: imported under a free local id, then linked. */
  private async pullNew(userId: string, summary: ShaderSummary, links: Links): Promise<void> {
    const account = await this.fetchPayload(userId, summary.id);
    if (!account) return;
    const { imported } = await this.library.importPayloads([account], 'rename');
    const record = await this.library.read(imported[0].id);
    links[record.id] = {
      remoteId: summary.id,
      remoteRevision: summary.revision,
      localRevision: record.revision,
      localThumbnail: record.thumbnail?.updatedAt ?? null,
      remoteThumbnail: account.thumbnail?.updatedAt ?? null,
    };
    await this.writeLinks(userId, links);
    if (this.userId === userId) this.checked.add(record.id);
  }

  /** The account's version of a shader, or `null` once it is gone. */
  private async fetchPayload(userId: string, remoteId: string): Promise<ShaderPayload | null> {
    const response = await this.call(userId, `/api/shaders/${encodeURIComponent(remoteId)}/export`);
    if (response.status === 404) return null;
    const parsed = parseBundle(await (await expectOk(response)).json());
    if (!parsed.ok) throw new Error('The account version could not be read');
    return parsed.value[0];
  }

  /** `replaceFromPayload` leaves thumbnails alone: write the payload's, or none. */
  private applyThumbnail(id: string, payload: ShaderPayload): Promise<ShaderRecord> {
    return payload.thumbnail?.data
      ? this.library.setThumbnail(id, {
          ext: payload.thumbnail.ext,
          bytes: Buffer.from(payload.thumbnail.data, 'base64'),
        })
      : this.library.clearThumbnail(id);
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
    const current = await this.call(userId, base);
    if (current.status === 404) return this.unlink(userId, id, links);
    const { shader: remote } = (await (await expectOk(current)).json()) as {
      shader: ShaderRecord;
    };
    const account = await this.fetchPayload(userId, link.remoteId);
    if (!account) return this.unlink(userId, id, links);

    const name = local.name.slice(0, LIMITS.nameLength - CONFLICT_SUFFIX.length);
    await this.library.importPayloads([{ ...local, name: name + CONFLICT_SUFFIX }], 'rename');
    await this.library.replaceFromPayload(id, account, localRevision);
    // The linked slot takes the account's thumbnail, or none.
    const record = await this.applyThumbnail(id, account);
    this.replaced.push(id);
    links[id] = {
      remoteId: link.remoteId,
      remoteRevision: remote.revision,
      localRevision: record.revision,
      localThumbnail: record.thumbnail?.updatedAt ?? null,
      remoteThumbnail: account.thumbnail?.updatedAt ?? null,
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
    void this.snapshot().then(
      (event) => {
        const replaced = this.replaced.splice(0);
        this.emit(replaced.length > 0 ? { ...event, replaced } : event);
      },
      (error: unknown) => {
        // After dispose the library may already be closed: nothing to report.
        if (!this.disposed) console.error('[sync] status failed', error);
      },
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

  private async readIgnored(userId: string): Promise<Set<string>> {
    return new Set(
      JSON.parse((await this.library.getMeta(ignoredKey(userId))) ?? '[]') as string[],
    );
  }

  private async writeIgnored(userId: string, remoteIds: Set<string>): Promise<void> {
    await this.library.setMeta(ignoredKey(userId), JSON.stringify([...remoteIds]));
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
