import { isPlatformServer } from '@angular/common';
import { Injectable, PLATFORM_ID, TransferState, inject, makeStateKey } from '@angular/core';

import type { ShaderRecord, ShaderSummary } from '@shader-studio/shared/model';
import { ShaderApi } from '../../api/shader-api';
import { Preferences } from '../../prefs/preferences';
import { OutputLog } from '../../ui/bottom-panel/output-log';
import { CompilationService } from '../compilation.service';
import { DocumentState } from '../state/document-state';
import { RecoveryFacade } from './recovery-facade';
import { reportWorkspaceError } from './report';

/**
 * What the server rendered, handed to the client inside the HTML.
 *
 * Without this the client's first render would start from an empty workspace
 * while the SSR markup already showed a shader, and hydration would throw the
 * whole subtree away. Reading it synchronously in the constructor means the
 * first client render is identical to the server's.
 */
interface StoreSnapshot {
  shaders: readonly ShaderSummary[];
  record: ShaderRecord | null;
}

const SNAPSHOT_KEY = makeStateKey<StoreSnapshot>('shader-studio.snapshot');

/**
 * Which shader is open, and everything involved in changing that answer.
 *
 * One path installs a record — `adopt` — and everything else goes through it:
 * the first server render, hydration, the remembered shader, a route, a newly
 * created or duplicated shader, a discarded draft. That is what makes "a
 * compile reset happens exactly once per adopted shader" and "a recovered draft
 * is looked for exactly once per adopted shader" true by construction rather
 * than by every caller remembering.
 *
 * It owns no document data of its own. The record, the draft, the list and the
 * loading flag all live in `DocumentState`; this class decides *when* they
 * change and calls the transition that changes them.
 *
 * Two collaborators sit either side of it. `RecoveryFacade` answers what a
 * record's project actually is and what unsaved work belongs to it;
 * `CompilationService` owns the revision that has to be reset when the document
 * underneath the waiters is replaced.
 */
@Injectable({ providedIn: 'root' })
export class SelectionLifecycle {
  private readonly api = inject(ShaderApi);
  private readonly preferences = inject(Preferences);
  private readonly transferState = inject(TransferState);
  private readonly documentState = inject(DocumentState);
  private readonly compilation = inject(CompilationService);
  private readonly recovery = inject(RecoveryFacade);
  private readonly outputLog = inject(OutputLog);
  private readonly isServer = isPlatformServer(inject(PLATFORM_ID));

  /** True once the client has taken over the server's snapshot. */
  private hydrated = false;

  /**
   * Which selection is the current one.
   *
   * A read is not instant and selections are not queued: click Waves, change
   * your mind and click Plasma, and there is no guarantee the server answers in
   * that order. Every attempt to install a record claims a token; a response
   * whose token is no longer the latest is dropped rather than adopted, so the
   * shader the user asked for last is the shader they get.
   */
  private generation = 0;

  /**
   * How many reads are outstanding. `loading` is true while any of them is, and
   * false only once the last one lands — tracked separately from `generation`
   * so that a superseded read still clears the spinner it raised.
   */
  private inFlight = 0;

  constructor() {
    if (this.isServer || !this.transferState.hasKey(SNAPSHOT_KEY)) return;

    const snapshot = this.transferState.get(SNAPSHOT_KEY, null);
    this.transferState.remove(SNAPSHOT_KEY);
    if (!snapshot) return;

    this.documentState.shaders.set(snapshot.shaders);
    if (snapshot.record) this.adopt(snapshot.record);
    this.hydrated = true;
  }

  // --- Startup --------------------------------------------------------------

  /**
   * Load the collection and open the first shader, then publish the result for
   * the client to pick up. Runs during SSR, against the same Express process's
   * own `/api`.
   *
   * The server deliberately does *not* honour `lastShaderId`: it has no access
   * to the browser's storage, and rendering a different shader than the client
   * would then hydrate is exactly the mismatch this snapshot exists to avoid.
   * The client switches to the remembered shader once it takes over.
   */
  async initialize(routeShaderId?: string | null): Promise<void> {
    await this.refreshList();

    const shaders = this.documentState.shaders();
    const requested =
      routeShaderId && shaders.some((shader) => shader.id === routeShaderId)
        ? routeShaderId
        : shaders[0]?.id;
    if (requested) await this.select(requested);

    if (this.isServer) {
      this.transferState.set(SNAPSHOT_KEY, {
        shaders: this.documentState.shaders(),
        record: this.documentState.record(),
      });
    }
  }

  /**
   * Called once the browser has taken over. If the server already sent a
   * snapshot there is nothing to fetch — we only need to honour the shader the
   * user last had open.
   */
  async initializeClient(routeShaderId?: string | null): Promise<void> {
    // Read before `initialize`, not after: opening the first shader writes it
    // to `lastShaderId`, which would leave nothing left to honour.
    const preferred = routeShaderId ?? this.preferences.value().lastShaderId;

    if (!this.hydrated) {
      await this.initialize(routeShaderId);
    }

    if (preferred && preferred !== this.documentState.selectedId()) {
      if (this.documentState.shaders().some((shader) => shader.id === preferred)) {
        await this.select(preferred);
      }
    }
  }

  // --- The collection -------------------------------------------------------

  async refreshList(): Promise<void> {
    try {
      this.documentState.shaders.set(await this.api.list());
    } catch (error) {
      this.report(error);
    }
  }

  // --- Selection ------------------------------------------------------------

  /** Open a shader, unless it is already the open one. */
  async select(id: string): Promise<void> {
    if (this.documentState.selectedId() === id && this.documentState.record() !== null) return;

    const token = ++this.generation;
    this.inFlight++;
    this.documentState.loading.set(true);

    try {
      const record = await this.api.read(id);
      // Someone selected something else while this read was in the air. Its
      // answer is about a document nobody is looking at any more.
      if (token !== this.generation) return;

      this.adopt(record);
      this.remember(id);
    } catch (error) {
      if (token === this.generation) this.report(error);
    } finally {
      if (--this.inFlight === 0) this.documentState.loading.set(false);
    }
  }

  /**
   * `select`, but reloads even if the id is already the open one — what an
   * import that replaced the open shader underneath the user needs.
   */
  async forceSelect(id: string): Promise<void> {
    this.documentState.record.set(null);
    await this.select(id);
  }

  /**
   * Take a server record as the new truth. The only path that installs one.
   *
   * `DocumentState.adopt` deliberately leaves the compile revision alone, so
   * resetting it is this method's job: the waiters queued against the document
   * being replaced are waiting for a compile that will now never mean what they
   * asked about.
   */
  adopt(record: ShaderRecord): void {
    const plan = this.recovery.planAdoption(record);

    this.documentState.adopt(record, plan.project);
    this.compilation.reset();
    this.recovery.completeAdoption(record, plan);
  }

  /**
   * A record the server has just made for us — created, duplicated — installed
   * without a second read of what we are already holding.
   */
  adoptCreated(record: ShaderRecord): void {
    this.cancelPending();
    this.adopt(record);
    this.remember(record.id);
  }

  /**
   * No shader open at all: what deleting the open one leaves behind until
   * `selectFallback` finds the next.
   */
  clearCurrent(): void {
    this.cancelPending();
    this.documentState.clearWorkspace();
    this.preferences.patch({ lastShaderId: null });
    this.compilation.reset();
  }

  /**
   * Open the first shader left in the collection. Answers whether there was
   * one — an empty library is a legitimate resting state, not a failure.
   */
  async selectFallback(): Promise<boolean> {
    const next = this.documentState.shaders()[0];
    if (!next) return false;

    await this.select(next.id);
    return true;
  }

  /**
   * Throw the draft away and re-open the record underneath it.
   *
   * The recovery copy goes first: re-adopting looks for one, and finding the
   * draft that was just discarded would put it straight back.
   */
  discardDraft(): void {
    const record = this.documentState.record();
    if (!record) return;

    this.recovery.forget(record.id);
    this.adopt(record);
  }

  // --- Internals ------------------------------------------------------------

  private remember(id: string): void {
    this.preferences.patch({ lastShaderId: id });
  }

  /**
   * Something other than a read has decided what is open. Any read still in the
   * air is now about the wrong document.
   */
  private cancelPending(): void {
    this.generation++;
  }

  private report(error: unknown): void {
    reportWorkspaceError(error, this.documentState, this.outputLog);
  }
}
