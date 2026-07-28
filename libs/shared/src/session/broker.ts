/**
 * Transport-neutral workspace session broker.
 *
 * Owns the single authoritative draft for one session. Renderers talk to it
 * through {@link SessionTransport} adapters; this module never touches DOM,
 * Electron, Monaco, or WebGL.
 */

import {
  asSessionClientId,
  asSessionId,
  createSessionClientId,
  createSessionId,
  type SessionClientId,
  type SessionId,
} from './ids';
import { parseSessionCommand } from './validate';
import {
  emptySessionSnapshot,
  type SessionClientPresence,
  type SessionClientRole,
  type SessionCommand,
  type SessionDocumentState,
  type SessionDraftMeta,
  type SessionEditorViewState,
  type SessionEvent,
  type SessionEventEnvelope,
  type SessionParams,
  type SessionRejection,
  type SessionSnapshot,
  type SessionTextEdit,
} from './types';
import {
  negotiateSessionProtocol,
  SESSION_PROTOCOL_VERSION,
  SUPPORTED_SESSION_PROTOCOL_VERSIONS,
} from './version';

export type SessionEventListener = (envelope: SessionEventEnvelope) => void;

export interface SessionBrokerOptions {
  sessionId?: SessionId;
  /** Disconnect clients that miss heartbeats for this many ms (0 = disabled). */
  heartbeatTimeoutMs?: number;
  now?: () => number;
}

interface ConnectedClient {
  presence: SessionClientPresence;
}

interface Checkpoint {
  shaderId: string | null;
  documents: Record<string, SessionDocumentState>;
  openDocumentIds: string[];
  activeDocumentId: string | null;
  params: SessionParams;
  paramsRevision: number;
  draftMeta: SessionDraftMeta | null;
}

/**
 * Roles allowed to mutate draft content (edit, claim, open/close tabs).
 * Observers are subscribe-only aside from heartbeat / disconnect / resync.
 */
const MUTATING_ROLES: ReadonlySet<SessionClientRole> = new Set(['controller', 'editor']);
const CONTROLLER_ONLY: ReadonlySet<SessionCommand['type']> = new Set([
  'selectShader',
  'save',
  'revert',
  'replaceDraft',
  'reportDiagnostics',
  'reportCompilation',
]);

export class SessionBroker {
  readonly sessionId: SessionId;
  private readonly heartbeatTimeoutMs: number;
  private readonly now: () => number;

  private sessionRevision = 0;
  private eventSeq = 0;
  private dirty = false;
  private saving = false;
  private shaderId: string | null = null;
  private activeDocumentId: string | null = null;
  private openDocumentIds: string[] = [];
  private documents = new Map<string, SessionDocumentState>();
  private params: SessionParams = {};
  private paramsRevision = 0;
  private diagnostics: SessionSnapshot['diagnostics'] = [];
  private compileRevision: number | null = null;
  private compileStatus: SessionSnapshot['compileStatus'] = 'idle';
  private draftMeta: SessionDraftMeta | null = null;
  private checkpoint: Checkpoint | null = null;

  private readonly clients = new Map<SessionClientId, ConnectedClient>();
  private readonly listeners = new Set<SessionEventListener>();
  private mutateQueue: Promise<void> = Promise.resolve();

  constructor(options: SessionBrokerOptions = {}) {
    this.sessionId = options.sessionId ?? createSessionId();
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 0;
    this.now = options.now ?? (() => Date.now());
  }

  subscribe(listener: SessionEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): SessionSnapshot {
    return this.buildSnapshot();
  }

  /** Process a client command. Returns the rejection when the command fails. */
  async dispatch(
    clientId: SessionClientId | null,
    command: SessionCommand,
    commandId = 'local',
  ): Promise<SessionRejection | null> {
    const parsed = parseSessionCommand(command);
    if (!parsed.ok) {
      const rejection: SessionRejection = {
        code: 'VALIDATION_ERROR',
        message: parsed.errors.join('; '),
        commandId,
        commandType:
          typeof command === 'object' && command && 'type' in command
            ? String((command as { type: unknown }).type)
            : undefined,
      };
      this.emit({ type: 'rejected', rejection });
      return rejection;
    }

    return this.enqueue(() => this.handleCommand(clientId, parsed.value, commandId));
  }

  /**
   * Sweep timed-out clients. Call from a host timer when
   * `heartbeatTimeoutMs > 0`.
   */
  sweepHeartbeats(): void {
    if (this.heartbeatTimeoutMs <= 0) return;
    const cutoff = this.now() - this.heartbeatTimeoutMs;
    for (const [clientId, client] of [...this.clients]) {
      if (client.presence.lastSeenAt < cutoff) {
        this.disconnectClient(clientId, 'timeout');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private enqueue(task: () => SessionRejection | null): Promise<SessionRejection | null> {
    const run = this.mutateQueue.then(task, task);
    this.mutateQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private handleCommand(
    clientId: SessionClientId | null,
    command: SessionCommand,
    commandId: string,
  ): SessionRejection | null {
    if (command.type === 'hello') {
      return this.handleHello(command, commandId);
    }

    if (!clientId || !this.clients.has(clientId)) {
      return this.reject(clientId, commandId, command.type, {
        code: 'NOT_CONNECTED',
        message: 'Client is not connected; send hello first.',
      });
    }

    const client = this.clients.get(clientId)!;
    client.presence.lastSeenAt = this.now();

    switch (command.type) {
      case 'heartbeat':
        this.emit({ type: 'heartbeatAck', serverTime: this.now() }, clientId);
        return null;
      case 'disconnect':
        this.disconnectClient(clientId, 'disconnect');
        return null;
      case 'requestResync':
        this.emit({ type: 'snapshot', snapshot: this.buildSnapshot(), reason: 'resync' }, clientId);
        return null;
      default:
        break;
    }

    const auth = this.authorize(client.presence.role, command.type);
    if (auth) {
      return this.reject(clientId, commandId, command.type, auth);
    }

    switch (command.type) {
      case 'selectShader':
        return this.handleSelectShader(command.shaderId);
      case 'openDocument':
        return this.handleOpenDocument(clientId, commandId, command.documentId);
      case 'closeDocument':
        return this.handleCloseDocument(clientId, commandId, command.documentId);
      case 'selectDocument':
        return this.handleSelectDocument(clientId, commandId, command.documentId);
      case 'moveDocument':
        return this.handleMoveDocument(clientId, commandId, command);
      case 'claimOwnership':
        return this.handleClaim(clientId, commandId, command.documentId);
      case 'releaseOwnership':
        return this.handleRelease(clientId, commandId, command.documentId);
      case 'editDocument':
        return this.handleEdit(clientId, commandId, command);
      case 'patchDocument':
        return this.handlePatch(clientId, commandId, command);
      case 'setParams':
      case 'setParam':
      case 'resetParams':
      case 'applyPreset':
        return this.handleParams(clientId, commandId, command);
      case 'save':
        return this.handleSave(clientId, commandId);
      case 'revert':
        return this.handleRevert(clientId, commandId);
      case 'requestFocus':
        this.emit({
          type: 'focusRequested',
          target: command.target,
          fromClientId: clientId,
        });
        return null;
      case 'reportDiagnostics':
        this.diagnostics = [...command.diagnostics];
        this.compileRevision = command.compileRevision;
        this.compileStatus = command.compileStatus;
        this.emit({
          type: 'diagnostics',
          diagnostics: this.diagnostics,
          compileRevision: command.compileRevision,
          compileStatus: command.compileStatus,
        });
        return null;
      case 'reportCompilation':
        this.compileRevision = command.compileRevision;
        this.compileStatus = command.compileStatus;
        this.emit({
          type: 'compilation',
          compileStatus: command.compileStatus,
          compileRevision: command.compileRevision,
        });
        return null;
      case 'replaceDraft':
        return this.handleReplaceDraft(clientId, commandId, command);
    }
  }

  private handleHello(
    command: Extract<SessionCommand, { type: 'hello' }>,
    commandId: string,
  ): SessionRejection | null {
    const negotiated = negotiateSessionProtocol(command.protocolVersion);
    if (!negotiated.ok) {
      const rejection: SessionRejection = {
        code: 'PROTOCOL_MISMATCH',
        message: `Unsupported protocol version ${command.protocolVersion}`,
        commandId,
        commandType: 'hello',
        supportedProtocolVersions: [...SUPPORTED_SESSION_PROTOCOL_VERSIONS],
      };
      this.emit({ type: 'rejected', rejection });
      return rejection;
    }

    const clientId = command.clientId
      ? asSessionClientId(command.clientId)
      : createSessionClientId();

    if (this.clients.has(clientId)) {
      this.disconnectClient(clientId, 'replaced');
    }

    const now = this.now();
    const presence: SessionClientPresence = {
      clientId,
      role: command.role,
      label: command.label,
      connectedAt: now,
      lastSeenAt: now,
    };
    this.clients.set(clientId, { presence });

    this.emit({ type: 'clientJoined', client: { ...presence } });
    this.emit({ type: 'presence', clients: this.listClients() });
    this.emit(
      {
        type: 'welcome',
        clientId,
        protocolVersion: SESSION_PROTOCOL_VERSION,
        snapshot: this.buildSnapshot(),
      },
      clientId,
    );
    return null;
  }

  private handleSelectShader(shaderId: string | null): SessionRejection | null {
    this.shaderId = shaderId;
    this.bumpSession();
    this.emit({ type: 'shaderSelected', shaderId, sessionRevision: this.sessionRevision });
    return null;
  }

  private handleOpenDocument(
    clientId: SessionClientId,
    commandId: string,
    documentId: string,
  ): SessionRejection | null {
    const doc = this.documents.get(documentId);
    if (!doc) {
      return this.reject(clientId, commandId, 'openDocument', {
        code: 'NOT_FOUND',
        message: `Document "${documentId}" does not exist.`,
      });
    }
    if (!this.openDocumentIds.includes(documentId)) {
      this.openDocumentIds = [...this.openDocumentIds, documentId];
      this.bumpSession();
      this.emit({
        type: 'documentOpened',
        documentId,
        openDocumentIds: this.openDocumentIds,
        sessionRevision: this.sessionRevision,
      });
    }
    if (this.activeDocumentId !== documentId) {
      this.activeDocumentId = documentId;
      this.bumpSession();
      this.emit({
        type: 'documentSelected',
        documentId,
        sessionRevision: this.sessionRevision,
      });
    }
    return null;
  }

  private handleCloseDocument(
    clientId: SessionClientId,
    commandId: string,
    documentId: string,
  ): SessionRejection | null {
    if (!this.documents.has(documentId)) {
      return this.reject(clientId, commandId, 'closeDocument', {
        code: 'NOT_FOUND',
        message: `Document "${documentId}" does not exist.`,
      });
    }
    // Closing a tab never deletes source. Last open tab is retained.
    if (this.openDocumentIds.length <= 1 && this.openDocumentIds[0] === documentId) {
      return null;
    }
    if (!this.openDocumentIds.includes(documentId)) return null;

    this.openDocumentIds = this.openDocumentIds.filter((id) => id !== documentId);
    if (this.activeDocumentId === documentId) {
      this.activeDocumentId = this.openDocumentIds[0] ?? null;
    }
    this.bumpSession();
    this.emit({
      type: 'documentClosed',
      documentId,
      openDocumentIds: this.openDocumentIds,
      activeDocumentId: this.activeDocumentId,
      sessionRevision: this.sessionRevision,
    });
    return null;
  }

  private handleSelectDocument(
    clientId: SessionClientId,
    commandId: string,
    documentId: string,
  ): SessionRejection | null {
    if (!this.documents.has(documentId)) {
      return this.reject(clientId, commandId, 'selectDocument', {
        code: 'NOT_FOUND',
        message: `Document "${documentId}" does not exist.`,
      });
    }
    if (!this.openDocumentIds.includes(documentId)) {
      this.openDocumentIds = [...this.openDocumentIds, documentId];
      this.bumpSession();
      this.emit({
        type: 'documentOpened',
        documentId,
        openDocumentIds: this.openDocumentIds,
        sessionRevision: this.sessionRevision,
      });
    }
    this.activeDocumentId = documentId;
    this.bumpSession();
    this.emit({
      type: 'documentSelected',
      documentId,
      sessionRevision: this.sessionRevision,
    });
    return null;
  }

  private handleMoveDocument(
    clientId: SessionClientId,
    commandId: string,
    command: Extract<SessionCommand, { type: 'moveDocument' }>,
  ): SessionRejection | null {
    const doc = this.documents.get(command.documentId);
    if (!doc) {
      return this.reject(clientId, commandId, 'moveDocument', {
        code: 'NOT_FOUND',
        message: `Document "${command.documentId}" does not exist.`,
      });
    }
    if (doc.ownerClientId !== clientId && doc.ownerClientId !== null) {
      return this.reject(clientId, commandId, 'moveDocument', {
        code: 'NOT_OWNER',
        message: 'Only the writable owner (or an unclaimed document) may move ownership.',
        document: cloneDocument(doc),
      });
    }
    const target = asSessionClientId(command.targetClientId);
    if (!this.clients.has(target)) {
      return this.reject(clientId, commandId, 'moveDocument', {
        code: 'NOT_FOUND',
        message: `Target client "${target}" is not connected.`,
      });
    }
    const targetRole = this.clients.get(target)!.presence.role;
    if (!MUTATING_ROLES.has(targetRole)) {
      return this.reject(clientId, commandId, 'moveDocument', {
        code: 'UNAUTHORIZED',
        message: 'Target client cannot own documents.',
      });
    }

    const viewState = command.viewState === undefined ? doc.viewState : (command.viewState ?? null);
    const next: SessionDocumentState = {
      ...doc,
      ownerClientId: target,
      viewState,
    };
    this.documents.set(command.documentId, next);
    this.bumpSession();
    this.emit({
      type: 'ownershipChanged',
      documentId: command.documentId,
      ownerClientId: target,
      sessionRevision: this.sessionRevision,
      viewState,
    });
    return null;
  }

  private handleClaim(
    clientId: SessionClientId,
    commandId: string,
    documentId: string,
  ): SessionRejection | null {
    const doc = this.documents.get(documentId);
    if (!doc) {
      return this.reject(clientId, commandId, 'claimOwnership', {
        code: 'NOT_FOUND',
        message: `Document "${documentId}" does not exist.`,
      });
    }
    if (doc.ownerClientId === clientId) return null;
    if (doc.ownerClientId !== null) {
      return this.reject(clientId, commandId, 'claimOwnership', {
        code: 'ALREADY_OWNED',
        message: `Document is owned by ${doc.ownerClientId}.`,
        document: cloneDocument(doc),
        sessionRevision: this.sessionRevision,
      });
    }
    const next = { ...doc, ownerClientId: clientId };
    this.documents.set(documentId, next);
    this.bumpSession();
    this.emit({
      type: 'ownershipChanged',
      documentId,
      ownerClientId: clientId,
      sessionRevision: this.sessionRevision,
      viewState: next.viewState,
    });
    return null;
  }

  private handleRelease(
    clientId: SessionClientId,
    commandId: string,
    documentId: string,
  ): SessionRejection | null {
    const doc = this.documents.get(documentId);
    if (!doc) {
      return this.reject(clientId, commandId, 'releaseOwnership', {
        code: 'NOT_FOUND',
        message: `Document "${documentId}" does not exist.`,
      });
    }
    if (doc.ownerClientId !== clientId) {
      return this.reject(clientId, commandId, 'releaseOwnership', {
        code: 'NOT_OWNER',
        message: 'Only the current owner may release ownership.',
        document: cloneDocument(doc),
      });
    }
    const next = { ...doc, ownerClientId: null };
    this.documents.set(documentId, next);
    this.bumpSession();
    this.emit({
      type: 'ownershipChanged',
      documentId,
      ownerClientId: null,
      sessionRevision: this.sessionRevision,
      viewState: next.viewState,
    });
    return null;
  }

  private handleEdit(
    clientId: SessionClientId,
    commandId: string,
    command: Extract<SessionCommand, { type: 'editDocument' }>,
  ): SessionRejection | null {
    const doc = this.documents.get(command.documentId);
    if (!doc) {
      return this.reject(clientId, commandId, 'editDocument', {
        code: 'NOT_FOUND',
        message: `Document "${command.documentId}" does not exist.`,
      });
    }
    if (doc.ownerClientId !== clientId) {
      return this.reject(clientId, commandId, 'editDocument', {
        code: 'NOT_OWNER',
        message: 'Client does not own this document.',
        currentRevision: doc.revision,
        document: cloneDocument(doc),
        sessionRevision: this.sessionRevision,
      });
    }
    if (command.baseRevision !== doc.revision) {
      return this.reject(clientId, commandId, 'editDocument', {
        code: 'STALE_REVISION',
        message: `baseRevision ${command.baseRevision} is stale; document is at ${doc.revision}.`,
        currentRevision: doc.revision,
        document: cloneDocument(doc),
        sessionRevision: this.sessionRevision,
      });
    }

    const viewState = command.viewState === undefined ? doc.viewState : (command.viewState ?? null);
    const next: SessionDocumentState = {
      ...doc,
      source: command.source,
      revision: doc.revision + 1,
      viewState,
    };
    this.documents.set(command.documentId, next);
    this.dirty = true;
    this.bumpSession();
    this.emit({
      type: 'documentChanged',
      documentId: command.documentId,
      revision: next.revision,
      sessionRevision: this.sessionRevision,
      source: next.source,
      viewState,
    });
    this.emit({ type: 'saveState', dirty: true, saving: this.saving });
    return null;
  }

  private handlePatch(
    clientId: SessionClientId,
    commandId: string,
    command: Extract<SessionCommand, { type: 'patchDocument' }>,
  ): SessionRejection | null {
    const doc = this.documents.get(command.documentId);
    if (!doc) {
      return this.reject(clientId, commandId, 'patchDocument', {
        code: 'NOT_FOUND',
        message: `Document "${command.documentId}" does not exist.`,
      });
    }
    if (doc.ownerClientId !== clientId) {
      return this.reject(clientId, commandId, 'patchDocument', {
        code: 'NOT_OWNER',
        message: 'Client does not own this document.',
        currentRevision: doc.revision,
        document: cloneDocument(doc),
        sessionRevision: this.sessionRevision,
      });
    }
    if (command.baseRevision !== doc.revision) {
      return this.reject(clientId, commandId, 'patchDocument', {
        code: 'STALE_REVISION',
        message: `baseRevision ${command.baseRevision} is stale; document is at ${doc.revision}.`,
        currentRevision: doc.revision,
        document: cloneDocument(doc),
        sessionRevision: this.sessionRevision,
      });
    }

    const patched = applyTextEdits(doc.source, command.edits);
    if (!patched.ok) {
      return this.reject(clientId, commandId, 'patchDocument', {
        code: 'VALIDATION_ERROR',
        message: patched.message,
        currentRevision: doc.revision,
        document: cloneDocument(doc),
      });
    }

    return this.handleEdit(clientId, commandId, {
      type: 'editDocument',
      documentId: command.documentId,
      baseRevision: command.baseRevision,
      source: patched.source,
      viewState: command.viewState,
    });
  }

  private handleParams(
    clientId: SessionClientId,
    commandId: string,
    command: Extract<
      SessionCommand,
      { type: 'setParams' | 'setParam' | 'resetParams' | 'applyPreset' }
    >,
  ): SessionRejection | null {
    if (command.baseRevision !== this.paramsRevision) {
      return this.reject(clientId, commandId, command.type, {
        code: 'STALE_REVISION',
        message: `baseRevision ${command.baseRevision} is stale; params are at ${this.paramsRevision}.`,
        currentRevision: this.paramsRevision,
        sessionRevision: this.sessionRevision,
        snapshot: this.buildSnapshot(),
      });
    }

    let next: SessionParams;
    if (command.type === 'setParam') {
      next = { ...this.params, [command.key]: command.value };
    } else if (command.type === 'setParams' || command.type === 'applyPreset') {
      next = { ...this.params, ...command.params };
    } else {
      next = { ...command.params };
    }

    this.params = next;
    this.paramsRevision += 1;
    this.dirty = true;
    this.bumpSession();
    this.emit({
      type: 'paramsChanged',
      params: { ...this.params },
      paramsRevision: this.paramsRevision,
      sessionRevision: this.sessionRevision,
    });
    this.emit({ type: 'saveState', dirty: true, saving: this.saving });
    return null;
  }

  private handleSave(clientId: SessionClientId, commandId: string): SessionRejection | null {
    if (this.saving) {
      return this.reject(clientId, commandId, 'save', {
        code: 'SAVE_IN_PROGRESS',
        message: 'A save or revert is already in progress.',
      });
    }
    this.saving = true;
    this.emit({ type: 'saveState', dirty: this.dirty, saving: true });

    this.checkpoint = this.captureCheckpoint();
    this.dirty = false;
    this.saving = false;
    this.bumpSession();
    this.emit({ type: 'saveState', dirty: false, saving: false });
    this.emit({ type: 'snapshot', snapshot: this.buildSnapshot(), reason: 'save' });
    return null;
  }

  private handleRevert(clientId: SessionClientId, commandId: string): SessionRejection | null {
    if (this.saving) {
      return this.reject(clientId, commandId, 'revert', {
        code: 'SAVE_IN_PROGRESS',
        message: 'A save or revert is already in progress.',
      });
    }
    if (!this.checkpoint) {
      return this.reject(clientId, commandId, 'revert', {
        code: 'NOT_FOUND',
        message: 'No saved checkpoint to revert to.',
      });
    }

    this.saving = true;
    this.emit({ type: 'saveState', dirty: this.dirty, saving: true });

    const cp = this.checkpoint;
    this.shaderId = cp.shaderId;
    this.documents = new Map(
      Object.entries(cp.documents).map(([id, doc]) => [
        id,
        {
          ...cloneDocument(doc),
          // Revert restores text but keeps live ownership / bumps revisions.
          ownerClientId: this.documents.get(id)?.ownerClientId ?? null,
          revision: (this.documents.get(id)?.revision ?? doc.revision) + 1,
        },
      ]),
    );
    this.openDocumentIds = [...cp.openDocumentIds];
    this.activeDocumentId = cp.activeDocumentId;
    this.params = { ...cp.params };
    this.paramsRevision += 1;
    this.draftMeta = cp.draftMeta ? { ...cp.draftMeta, render: { ...cp.draftMeta.render } } : null;
    this.dirty = false;
    this.saving = false;
    this.bumpSession();
    this.emit({ type: 'saveState', dirty: false, saving: false });
    this.emit({ type: 'snapshot', snapshot: this.buildSnapshot(), reason: 'revert' });
    return null;
  }

  private handleReplaceDraft(
    clientId: SessionClientId,
    commandId: string,
    command: Extract<SessionCommand, { type: 'replaceDraft' }>,
  ): SessionRejection | null {
    const nextDocs = new Map<string, SessionDocumentState>();
    for (const seed of command.documents) {
      nextDocs.set(seed.documentId, {
        documentId: seed.documentId,
        kind: seed.kind,
        name: seed.name,
        language: seed.language,
        source: seed.source,
        revision: 0,
        ownerClientId: null,
        viewState: seed.viewState ?? null,
      });
    }
    for (const id of command.openDocumentIds) {
      if (!nextDocs.has(id)) {
        return this.reject(clientId, commandId, 'replaceDraft', {
          code: 'VALIDATION_ERROR',
          message: `openDocumentIds references unknown document "${id}".`,
        });
      }
    }
    if (command.activeDocumentId && !nextDocs.has(command.activeDocumentId)) {
      return this.reject(clientId, commandId, 'replaceDraft', {
        code: 'VALIDATION_ERROR',
        message: `activeDocumentId references unknown document "${command.activeDocumentId}".`,
      });
    }

    this.shaderId = command.shaderId;
    this.documents = nextDocs;
    this.openDocumentIds = [...command.openDocumentIds];
    this.activeDocumentId = command.activeDocumentId;
    this.params = { ...command.params };
    this.paramsRevision = 0;
    this.draftMeta = command.draftMeta ?? null;
    this.dirty = command.dirty ?? false;
    this.diagnostics = [];
    this.compileRevision = null;
    this.compileStatus = 'idle';
    this.checkpoint = this.captureCheckpoint();
    this.bumpSession();
    this.emit({ type: 'snapshot', snapshot: this.buildSnapshot(), reason: 'replace' });
    this.emit({ type: 'saveState', dirty: this.dirty, saving: this.saving });
    return null;
  }

  private disconnectClient(
    clientId: SessionClientId,
    reason: 'disconnect' | 'timeout' | 'replaced',
  ): void {
    if (!this.clients.has(clientId)) return;
    this.clients.delete(clientId);

    for (const [documentId, doc] of this.documents) {
      if (doc.ownerClientId !== clientId) continue;
      const next = { ...doc, ownerClientId: null };
      this.documents.set(documentId, next);
      this.bumpSession();
      this.emit({
        type: 'ownershipChanged',
        documentId,
        ownerClientId: null,
        sessionRevision: this.sessionRevision,
        viewState: next.viewState,
      });
    }

    this.emit({ type: 'clientLeft', clientId, reason });
    this.emit({ type: 'presence', clients: this.listClients() });
  }

  private authorize(
    role: SessionClientRole,
    type: SessionCommand['type'],
  ): SessionRejection | null {
    if (type === 'heartbeat' || type === 'disconnect' || type === 'requestResync') {
      return null;
    }
    if (role === 'observer') {
      return {
        code: 'UNAUTHORIZED',
        message: `Observer cannot execute ${type}.`,
      };
    }
    if (CONTROLLER_ONLY.has(type) && role !== 'controller') {
      return {
        code: 'UNAUTHORIZED',
        message: `Only a controller may execute ${type}.`,
      };
    }
    if (
      (type === 'editDocument' ||
        type === 'patchDocument' ||
        type === 'claimOwnership' ||
        type === 'releaseOwnership' ||
        type === 'moveDocument' ||
        type === 'openDocument' ||
        type === 'closeDocument' ||
        type === 'selectDocument' ||
        type === 'setParams' ||
        type === 'setParam' ||
        type === 'resetParams' ||
        type === 'applyPreset' ||
        type === 'requestFocus') &&
      !MUTATING_ROLES.has(role)
    ) {
      return {
        code: 'UNAUTHORIZED',
        message: `Role ${role} cannot execute ${type}.`,
      };
    }
    return null;
  }

  private reject(
    clientId: SessionClientId | null,
    commandId: string,
    commandType: string,
    partial: Omit<SessionRejection, 'commandId' | 'commandType'> &
      Partial<Pick<SessionRejection, 'commandId' | 'commandType'>>,
  ): SessionRejection {
    const rejection: SessionRejection = {
      ...partial,
      commandId,
      commandType,
    };
    this.emit({ type: 'rejected', rejection }, clientId ?? undefined);
    return rejection;
  }

  private bumpSession(): void {
    this.sessionRevision += 1;
  }

  private listClients(): SessionClientPresence[] {
    return [...this.clients.values()].map((c) => ({ ...c.presence }));
  }

  private captureCheckpoint(): Checkpoint {
    const documents: Record<string, SessionDocumentState> = {};
    for (const [id, doc] of this.documents) {
      documents[id] = {
        ...cloneDocument(doc),
        ownerClientId: null,
      };
    }
    return {
      shaderId: this.shaderId,
      documents,
      openDocumentIds: [...this.openDocumentIds],
      activeDocumentId: this.activeDocumentId,
      params: { ...this.params },
      paramsRevision: this.paramsRevision,
      draftMeta: this.draftMeta
        ? { controlsText: this.draftMeta.controlsText, render: { ...this.draftMeta.render } }
        : null,
    };
  }

  private buildSnapshot(): SessionSnapshot {
    const documents: Record<string, SessionDocumentState> = {};
    for (const [id, doc] of this.documents) {
      documents[id] = cloneDocument(doc);
    }
    return {
      ...emptySessionSnapshot(asSessionId(this.sessionId)),
      sessionRevision: this.sessionRevision,
      shaderId: this.shaderId,
      dirty: this.dirty,
      saving: this.saving,
      activeDocumentId: this.activeDocumentId,
      openDocumentIds: [...this.openDocumentIds],
      documents,
      params: { ...this.params },
      paramsRevision: this.paramsRevision,
      diagnostics: [...this.diagnostics],
      compileRevision: this.compileRevision,
      compileStatus: this.compileStatus,
      clients: this.listClients(),
      draftMeta: this.draftMeta
        ? { controlsText: this.draftMeta.controlsText, render: { ...this.draftMeta.render } }
        : null,
    };
  }

  private emit(event: SessionEvent, targetClientId?: SessionClientId): void {
    this.eventSeq += 1;
    const envelope: SessionEventEnvelope = {
      kind: 'event',
      protocolVersion: SESSION_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      eventSeq: this.eventSeq,
      event,
    };
    // welcome / heartbeatAck / rejected may be targeted; others broadcast.
    // Listeners always see every envelope; transports may filter by target via
    // the optional meta on a wrapping adapter. For targeted events we still
    // broadcast — clients ignore welcome not addressed to them.
    void targetClientId;
    for (const listener of this.listeners) {
      listener(envelope);
    }
  }
}

function cloneDocument(doc: SessionDocumentState): SessionDocumentState {
  return {
    ...doc,
    viewState: doc.viewState ? { ...doc.viewState } : null,
  };
}

function applyTextEdits(
  source: string,
  edits: readonly SessionTextEdit[],
): { ok: true; source: string } | { ok: false; message: string } {
  // Apply from the end so earlier offsets stay valid.
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  let next = source;
  for (const edit of ordered) {
    if (edit.start > edit.end || edit.end > next.length || edit.start < 0) {
      return {
        ok: false,
        message: `Invalid edit range [${edit.start}, ${edit.end}) for source length ${next.length}.`,
      };
    }
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
  }
  return { ok: true, source: next };
}

export type { SessionEditorViewState };
