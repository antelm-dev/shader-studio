/**
 * Narrow transport seams for the workspace session protocol.
 *
 * - In-process Angular hosts share one {@link SessionBroker} via
 *   {@link InProcessSessionTransport}.
 * - Electron main hosts the broker and bridges renderer IPC with
 *   {@link SessionIpcBridge} shapes (typed channels; preload wires later).
 * - {@link BroadcastChannelSessionTransport} is a temporary migration aid
 *   (OutputSync replacement), not the final multi-writer authority.
 */

import type { SessionClientId, SessionId } from './ids';
import type {
  SessionCommand,
  SessionCommandEnvelope,
  SessionEventEnvelope,
  SessionRejection,
} from './types';
import type { SessionProtocolVersion } from './version';

/** Deliver events from the broker (or remote peer) to a local consumer. */
export type SessionEventHandler = (envelope: SessionEventEnvelope) => void;

/**
 * Client-facing transport: send commands, receive events.
 * Framework-agnostic — Angular services and Electron preload both implement this.
 */
export interface SessionClientTransport {
  readonly sessionId: SessionId;
  readonly clientId: SessionClientId | null;
  connect(): Promise<SessionClientId>;
  disconnect(): Promise<void>;
  send(command: SessionCommand, commandId?: string): Promise<SessionRejection | null>;
  subscribe(handler: SessionEventHandler): () => void;
}

/**
 * Host-facing endpoint that receives command envelopes from a remote renderer
 * and pushes event envelopes back. Electron main implements this over IPC.
 */
export interface SessionHostEndpoint {
  onCommand(handler: (envelope: SessionCommandEnvelope) => void | Promise<void>): () => void;
  postEvent(envelope: SessionEventEnvelope, targetClientId?: SessionClientId): void;
}

/**
 * Suggested IPC channel names for Electron. Agent 04 / gen:ipc should bind
 * these; this module only documents the seam.
 */
export const SESSION_IPC_CHANNELS = {
  /** Renderer → main: SessionCommandEnvelope */
  command: 'session:command',
  /** Main → renderer: SessionEventEnvelope */
  event: 'session:event',
} as const;

export interface SessionIpcCommandMessage {
  channel: typeof SESSION_IPC_CHANNELS.command;
  protocolVersion: SessionProtocolVersion;
  envelope: SessionCommandEnvelope;
}

export interface SessionIpcEventMessage {
  channel: typeof SESSION_IPC_CHANNELS.event;
  protocolVersion: SessionProtocolVersion;
  envelope: SessionEventEnvelope;
  /** When set, only that renderer should apply the event (welcome, heartbeatAck). */
  targetClientId?: SessionClientId;
}

/** Default BroadcastChannel name for the temporary migration adapter. */
export const SESSION_BROADCAST_CHANNEL = 'shader-studio.session';
