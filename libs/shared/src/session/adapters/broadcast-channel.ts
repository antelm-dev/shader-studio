/**
 * Temporary BroadcastChannel adapter for migration off OutputSync.
 *
 * Not the final multi-writer authority — the SessionBroker remains the single
 * source of truth. One process hosts the broker; peers post command envelopes
 * and receive event envelopes. Safe to import under SSR: the channel is only
 * opened in {@link connect} / {@link attachHost}, never at module evaluation.
 *
 * DOM types are intentionally not imported — `libs/shared` targets ES2022 only.
 */

import type { SessionBroker } from '../broker';
import { asSessionClientId, createSessionClientId, type SessionClientId } from '../ids';
import { SESSION_PROTOCOL_VERSION } from '../version';
import {
  SESSION_BROADCAST_CHANNEL,
  type SessionClientTransport,
  type SessionEventHandler,
} from '../transport';
import type {
  SessionCommand,
  SessionCommandEnvelope,
  SessionEventEnvelope,
  SessionRejection,
} from '../types';
import { parseSessionCommandEnvelope } from '../validate';

type WireMessage =
  | { kind: 'command'; envelope: SessionCommandEnvelope }
  | { kind: 'event'; envelope: SessionEventEnvelope };

interface BroadcastChannelLike {
  onmessage: ((ev: { data: unknown }) => void) | null;
  postMessage(data: unknown): void;
  close(): void;
}

interface BroadcastChannelCtor {
  new (name: string): BroadcastChannelLike;
}

function getBroadcastChannelCtor(): BroadcastChannelCtor | null {
  const g = globalThis as typeof globalThis & { BroadcastChannel?: BroadcastChannelCtor };
  return typeof g.BroadcastChannel === 'function' ? g.BroadcastChannel : null;
}

/**
 * Host side: attach a broker to a BroadcastChannel. Returns a disposer.
 */
export function attachSessionBrokerToBroadcastChannel(
  broker: SessionBroker,
  channelName = SESSION_BROADCAST_CHANNEL,
): () => void {
  const Ctor = getBroadcastChannelCtor();
  if (!Ctor) {
    return () => undefined;
  }
  const channel = new Ctor(channelName);
  const unsub = broker.subscribe((envelope) => {
    const message: WireMessage = { kind: 'event', envelope };
    channel.postMessage(message);
  });
  channel.onmessage = (ev) => {
    const data = ev.data as WireMessage | null;
    if (!data || data.kind !== 'command') return;
    const parsed = parseSessionCommandEnvelope(data.envelope);
    if (!parsed.ok) return;
    const { clientId, command, commandId } = parsed.value;
    void broker.dispatch(
      command.type === 'hello' ? null : asSessionClientId(clientId),
      command,
      commandId,
    );
  };
  return () => {
    unsub();
    channel.close();
  };
}

export interface BroadcastChannelSessionTransportOptions {
  sessionId: SessionBroker['sessionId'];
  role: 'controller' | 'editor' | 'observer';
  label?: string;
  clientId?: SessionClientId;
  channelName?: string;
}

/**
 * Client side over BroadcastChannel. Requires a host that called
 * {@link attachSessionBrokerToBroadcastChannel}.
 */
export class BroadcastChannelSessionTransport implements SessionClientTransport {
  readonly sessionId;
  private readonly role: BroadcastChannelSessionTransportOptions['role'];
  private readonly label?: string;
  private readonly preferredClientId?: SessionClientId;
  private readonly channelName: string;
  private channel: BroadcastChannelLike | null = null;
  private _clientId: SessionClientId | null = null;
  private seq = 0;
  private readonly handlers = new Set<SessionEventHandler>();
  private pendingHello: {
    resolve: (id: SessionClientId) => void;
    reject: (err: Error) => void;
    clientId: SessionClientId;
  } | null = null;

  constructor(options: BroadcastChannelSessionTransportOptions) {
    this.sessionId = options.sessionId;
    this.role = options.role;
    this.label = options.label;
    this.preferredClientId = options.clientId;
    this.channelName = options.channelName ?? SESSION_BROADCAST_CHANNEL;
  }

  get clientId(): SessionClientId | null {
    return this._clientId;
  }

  async connect(): Promise<SessionClientId> {
    if (this._clientId) return this._clientId;
    const Ctor = getBroadcastChannelCtor();
    if (!Ctor) {
      throw new Error('BroadcastChannel is unavailable in this environment.');
    }
    this.channel = new Ctor(this.channelName);
    this.channel.onmessage = (ev) => {
      const data = ev.data as WireMessage | null;
      if (!data || data.kind !== 'event') return;
      this.onEvent(data.envelope);
    };

    const clientId = this.preferredClientId ?? createSessionClientId();
    return new Promise<SessionClientId>((resolve, reject) => {
      this.pendingHello = { resolve, reject, clientId };
      const envelope: SessionCommandEnvelope = {
        kind: 'command',
        protocolVersion: SESSION_PROTOCOL_VERSION,
        sessionId: this.sessionId,
        clientId,
        commandId: 'hello',
        seq: ++this.seq,
        command: {
          type: 'hello',
          protocolVersion: SESSION_PROTOCOL_VERSION,
          role: this.role,
          label: this.label,
          clientId,
        },
      };
      this.channel?.postMessage({ kind: 'command', envelope } satisfies WireMessage);
    });
  }

  async disconnect(): Promise<void> {
    if (this._clientId && this.channel) {
      const envelope: SessionCommandEnvelope = {
        kind: 'command',
        protocolVersion: SESSION_PROTOCOL_VERSION,
        sessionId: this.sessionId,
        clientId: this._clientId,
        commandId: 'disconnect',
        seq: ++this.seq,
        command: { type: 'disconnect' },
      };
      this.channel.postMessage({ kind: 'command', envelope } satisfies WireMessage);
    }
    this.channel?.close();
    this.channel = null;
    this._clientId = null;
    this.pendingHello = null;
  }

  async send(command: SessionCommand, commandId?: string): Promise<SessionRejection | null> {
    if (!this._clientId || !this.channel) {
      return {
        code: 'NOT_CONNECTED',
        message: 'Transport is not connected.',
        commandId,
        commandType: command.type,
      };
    }
    const envelope: SessionCommandEnvelope = {
      kind: 'command',
      protocolVersion: SESSION_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      clientId: this._clientId,
      commandId: commandId ?? `cmd:${++this.seq}`,
      seq: this.seq,
      command,
    };
    this.channel.postMessage({ kind: 'command', envelope } satisfies WireMessage);
    // Fire-and-forget over BroadcastChannel; rejections arrive as events.
    return null;
  }

  subscribe(handler: SessionEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private onEvent(envelope: SessionEventEnvelope): void {
    if (envelope.event.type === 'welcome' && this.pendingHello) {
      if (envelope.event.clientId === this.pendingHello.clientId) {
        this._clientId = envelope.event.clientId;
        const { resolve } = this.pendingHello;
        this.pendingHello = null;
        resolve(envelope.event.clientId);
      }
    }
    if (envelope.event.type === 'rejected' && this.pendingHello) {
      const { reject } = this.pendingHello;
      this.pendingHello = null;
      reject(new Error(envelope.event.rejection.message));
    }
    for (const handler of this.handlers) handler(envelope);
  }
}
