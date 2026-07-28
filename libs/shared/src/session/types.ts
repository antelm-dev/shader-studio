/**
 * Framework-free workspace session protocol.
 *
 * One authoritative draft, many surface renderers. Snapshots and events are
 * immutable serializable data — never Monaco models, undo stacks, WebGL
 * contexts, or rendered frames.
 *
 * ## Ordering and backpressure
 *
 * - Broker events are totally ordered by `eventSeq` within a session.
 * - Clients MUST apply events in ascending `eventSeq`. A gap or missing
 *   predecessor requires `requestResync` (or reconnect hello) — do not guess.
 * - High-frequency paths use incremental `documentChanged` / `paramsChanged`
 *   events. Full `snapshot` events are reserved for connect, explicit resync,
 *   save/revert completion, and recovery after rejection.
 * - Transports MAY coalesce consecutive `documentChanged` events for the same
 *   `documentId` (keep the latest) or consecutive `paramsChanged` events when
 *   a consumer is behind. They MUST NOT drop `ownershipChanged`, `saveState`,
 *   `rejected`, `welcome`, `snapshot`, `client*`, or `resyncRequired`.
 * - If coalescing would leave a consumer unable to reconstruct state, emit
 *   `resyncRequired` instead of a partial stream.
 * - Commands are processed FIFO. Save and revert are additionally exclusive
 *   (serialized against each other and against overlapping mutating commands).
 */

import type { CompileDiagnostic } from '../diagnostics/types';
import type { SessionClientId, SessionId } from './ids';
import type { SessionProtocolVersion } from './version';
import { SESSION_PROTOCOL_VERSION } from './version';

// ---------------------------------------------------------------------------
// Roles & presence
// ---------------------------------------------------------------------------

/**
 * - `controller` — primary workspace host; may select shaders, save, revert.
 * - `editor` — may claim document ownership and edit source.
 * - `observer` — read-only subscribe (e.g. preview satellite).
 */
export type SessionClientRole = 'controller' | 'editor' | 'observer';

export const SESSION_CLIENT_ROLES: readonly SessionClientRole[] = [
  'controller',
  'editor',
  'observer',
] as const;

export type SessionDocumentKind = 'pass' | 'file' | 'vertex' | 'config';

export const SESSION_DOCUMENT_KINDS: readonly SessionDocumentKind[] = [
  'pass',
  'file',
  'vertex',
  'config',
] as const;

export type SessionParamValue = number | boolean | string;

export type SessionParams = Record<string, SessionParamValue>;

/**
 * Monaco `ICodeEditorViewState`-compatible JSON. Opaque to the broker; never an
 * editor instance. Undo/redo stacks are intentionally absent — they reset on
 * cross-renderer moves.
 */
export type SessionEditorViewState = Record<string, unknown>;

export interface SessionClientPresence {
  clientId: SessionClientId;
  role: SessionClientRole;
  label?: string;
  connectedAt: number;
  lastSeenAt: number;
}

// ---------------------------------------------------------------------------
// Snapshot (immutable, serializable)
// ---------------------------------------------------------------------------

export interface SessionDocumentState {
  documentId: string;
  kind: SessionDocumentKind;
  name: string;
  language: 'glsl' | 'json';
  source: string;
  /** Monotonic per-document revision. */
  revision: number;
  /** Writable owner, or null when unclaimed. */
  ownerClientId: SessionClientId | null;
  viewState: SessionEditorViewState | null;
}

export type SessionCompileStatus = 'idle' | 'compiling' | 'ok' | 'error';

/**
 * Full recoverable session state. Prefer incremental events for hot paths;
 * send this on hello, resync, and after save/revert.
 */
export interface SessionSnapshot {
  protocolVersion: SessionProtocolVersion;
  sessionId: SessionId;
  /** Monotonic session-wide revision (documents, params, selection, ownership). */
  sessionRevision: number;
  shaderId: string | null;
  dirty: boolean;
  saving: boolean;
  activeDocumentId: string | null;
  openDocumentIds: readonly string[];
  documents: Readonly<Record<string, SessionDocumentState>>;
  params: SessionParams;
  /** Bumps with param mutations; used for stale param command checks. */
  paramsRevision: number;
  diagnostics: readonly CompileDiagnostic[];
  compileRevision: number | null;
  compileStatus: SessionCompileStatus;
  clients: readonly SessionClientPresence[];
  /** Opaque serializable draft extras (controls JSON, render settings, …). */
  draftMeta: SessionDraftMeta | null;
}

export interface SessionDraftMeta {
  controlsText: string;
  render: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Rejection / errors
// ---------------------------------------------------------------------------

export type SessionRejectionCode =
  | 'PROTOCOL_MISMATCH'
  | 'UNAUTHORIZED'
  | 'NOT_CONNECTED'
  | 'STALE_REVISION'
  | 'NOT_OWNER'
  | 'ALREADY_OWNED'
  | 'NOT_FOUND'
  | 'INVALID_COMMAND'
  | 'SAVE_IN_PROGRESS'
  | 'BUSY'
  | 'VALIDATION_ERROR';

export interface SessionRejection {
  code: SessionRejectionCode;
  message: string;
  commandId?: string;
  commandType?: string;
  /** Present on stale edits / ownership races. */
  currentRevision?: number;
  sessionRevision?: number;
  /** Enough state to resync without a full round-trip when small. */
  document?: SessionDocumentState;
  /** Full snapshot when the broker decides incremental repair is insufficient. */
  snapshot?: SessionSnapshot;
  supportedProtocolVersions?: readonly number[];
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface SessionTextEdit {
  start: number;
  end: number;
  text: string;
}

export type SessionFocusTarget =
  | { kind: 'document'; documentId: string }
  | { kind: 'surface'; surfaceId: string }
  | { kind: 'shader'; shaderId: string };

export type SessionCommand =
  | {
      type: 'hello';
      protocolVersion: number;
      role: SessionClientRole;
      label?: string;
      /** Optional stable id; broker allocates when omitted. */
      clientId?: SessionClientId;
    }
  | { type: 'heartbeat' }
  | { type: 'disconnect' }
  | { type: 'requestResync'; reason?: string }
  | { type: 'selectShader'; shaderId: string | null }
  | { type: 'openDocument'; documentId: string }
  | { type: 'closeDocument'; documentId: string }
  | { type: 'selectDocument'; documentId: string }
  | {
      type: 'moveDocument';
      documentId: string;
      targetClientId: SessionClientId;
      viewState?: SessionEditorViewState | null;
    }
  | { type: 'claimOwnership'; documentId: string }
  | { type: 'releaseOwnership'; documentId: string }
  | {
      type: 'editDocument';
      documentId: string;
      baseRevision: number;
      source: string;
      viewState?: SessionEditorViewState | null;
    }
  | {
      type: 'patchDocument';
      documentId: string;
      baseRevision: number;
      edits: readonly SessionTextEdit[];
      viewState?: SessionEditorViewState | null;
    }
  | { type: 'setParams'; baseRevision: number; params: SessionParams }
  | { type: 'setParam'; baseRevision: number; key: string; value: SessionParamValue }
  | { type: 'resetParams'; baseRevision: number; params: SessionParams }
  | { type: 'applyPreset'; presetId: string; params: SessionParams; baseRevision: number }
  | { type: 'save' }
  | { type: 'revert' }
  | { type: 'requestFocus'; target: SessionFocusTarget }
  | {
      type: 'reportDiagnostics';
      diagnostics: readonly CompileDiagnostic[];
      compileRevision: number;
      compileStatus: SessionCompileStatus;
    }
  | {
      type: 'reportCompilation';
      compileStatus: SessionCompileStatus;
      compileRevision: number;
    }
  /** Seed / replace authoritative documents (controller bootstrap / load). */
  | {
      type: 'replaceDraft';
      shaderId: string | null;
      documents: readonly Omit<SessionDocumentState, 'ownerClientId' | 'revision'>[];
      openDocumentIds: readonly string[];
      activeDocumentId: string | null;
      params: SessionParams;
      draftMeta?: SessionDraftMeta | null;
      dirty?: boolean;
    };

export type SessionCommandType = SessionCommand['type'];

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type SessionEvent =
  | {
      type: 'welcome';
      clientId: SessionClientId;
      protocolVersion: SessionProtocolVersion;
      snapshot: SessionSnapshot;
    }
  | { type: 'rejected'; rejection: SessionRejection }
  | {
      type: 'snapshot';
      snapshot: SessionSnapshot;
      reason: 'resync' | 'save' | 'revert' | 'replace';
    }
  | {
      type: 'documentChanged';
      documentId: string;
      revision: number;
      sessionRevision: number;
      source: string;
      viewState: SessionEditorViewState | null;
    }
  | {
      type: 'documentOpened';
      documentId: string;
      openDocumentIds: readonly string[];
      sessionRevision: number;
    }
  | {
      type: 'documentClosed';
      documentId: string;
      openDocumentIds: readonly string[];
      activeDocumentId: string | null;
      sessionRevision: number;
    }
  | {
      type: 'documentSelected';
      documentId: string | null;
      sessionRevision: number;
    }
  | {
      type: 'ownershipChanged';
      documentId: string;
      ownerClientId: SessionClientId | null;
      sessionRevision: number;
      /** View state to apply when ownership moves across renderers. */
      viewState: SessionEditorViewState | null;
    }
  | {
      type: 'paramsChanged';
      params: SessionParams;
      paramsRevision: number;
      sessionRevision: number;
    }
  | {
      type: 'diagnostics';
      diagnostics: readonly CompileDiagnostic[];
      compileRevision: number;
      compileStatus: SessionCompileStatus;
    }
  | {
      type: 'compilation';
      compileStatus: SessionCompileStatus;
      compileRevision: number;
    }
  | { type: 'saveState'; dirty: boolean; saving: boolean }
  | { type: 'shaderSelected'; shaderId: string | null; sessionRevision: number }
  | { type: 'clientJoined'; client: SessionClientPresence }
  | { type: 'clientLeft'; clientId: SessionClientId; reason: 'disconnect' | 'timeout' | 'replaced' }
  | { type: 'presence'; clients: readonly SessionClientPresence[] }
  | {
      type: 'focusRequested';
      target: SessionFocusTarget;
      fromClientId: SessionClientId;
    }
  | { type: 'heartbeatAck'; serverTime: number }
  | { type: 'resyncRequired'; reason: string };

export type SessionEventType = SessionEvent['type'];

// ---------------------------------------------------------------------------
// Wire envelopes
// ---------------------------------------------------------------------------

export interface SessionCommandEnvelope {
  kind: 'command';
  protocolVersion: SessionProtocolVersion;
  sessionId: SessionId;
  clientId: SessionClientId;
  commandId: string;
  /** Per-client outbound monotonic sequence. */
  seq: number;
  command: SessionCommand;
}

export interface SessionEventEnvelope {
  kind: 'event';
  protocolVersion: SessionProtocolVersion;
  sessionId: SessionId;
  /** Broker-emitted total order. */
  eventSeq: number;
  event: SessionEvent;
}

export type SessionEnvelope = SessionCommandEnvelope | SessionEventEnvelope;

export function emptySessionSnapshot(sessionId: SessionId): SessionSnapshot {
  return {
    protocolVersion: SESSION_PROTOCOL_VERSION,
    sessionId,
    sessionRevision: 0,
    shaderId: null,
    dirty: false,
    saving: false,
    activeDocumentId: null,
    openDocumentIds: [],
    documents: {},
    params: {},
    paramsRevision: 0,
    diagnostics: [],
    compileRevision: null,
    compileStatus: 'idle',
    clients: [],
    draftMeta: null,
  };
}
