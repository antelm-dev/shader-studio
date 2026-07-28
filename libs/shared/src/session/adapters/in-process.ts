/**
 * In-process transport: multiple Angular surfaces share one SessionBroker.
 * No DOM / BroadcastChannel — safe for SSR as long as the broker is created
 * lazily in an Angular injector (not at module evaluation).
 */

import type { SessionBroker } from '../broker';
import { asSessionClientId, createSessionClientId, type SessionClientId } from '../ids';
import type { SessionClientTransport, SessionEventHandler } from '../transport';
import type { SessionCommand, SessionRejection } from '../types';
import { SESSION_PROTOCOL_VERSION } from '../version';

export interface InProcessSessionTransportOptions {
  broker: SessionBroker;
  role: 'controller' | 'editor' | 'observer';
  label?: string;
  clientId?: SessionClientId;
}

export class InProcessSessionTransport implements SessionClientTransport {
  readonly sessionId;
  private readonly broker: SessionBroker;
  private readonly role: InProcessSessionTransportOptions['role'];
  private readonly label?: string;
  private readonly preferredClientId?: SessionClientId;
  private _clientId: SessionClientId | null = null;
  private seq = 0;
  private unsubBroker: (() => void) | null = null;
  private readonly handlers = new Set<SessionEventHandler>();

  constructor(options: InProcessSessionTransportOptions) {
    this.broker = options.broker;
    this.sessionId = options.broker.sessionId;
    this.role = options.role;
    this.label = options.label;
    this.preferredClientId = options.clientId;
  }

  get clientId(): SessionClientId | null {
    return this._clientId;
  }

  async connect(): Promise<SessionClientId> {
    if (this._clientId) return this._clientId;

    const pendingId = this.preferredClientId ?? createSessionClientId();
    let resolved: SessionClientId | null = null;

    const stop = this.broker.subscribe((envelope) => {
      if (envelope.event.type === 'welcome' && envelope.event.clientId === pendingId) {
        resolved = envelope.event.clientId;
      }
      if (
        envelope.event.type === 'welcome' &&
        this.preferredClientId &&
        envelope.event.clientId === this.preferredClientId
      ) {
        resolved = envelope.event.clientId;
      }
      // Also accept broker-assigned id when we did not pin one: match by catching
      // the next welcome after our hello. Handled below after dispatch.
      for (const handler of this.handlers) handler(envelope);
    });
    this.unsubBroker = stop;

    const rejection = await this.broker.dispatch(null, {
      type: 'hello',
      protocolVersion: SESSION_PROTOCOL_VERSION,
      role: this.role,
      label: this.label,
      clientId: pendingId,
    });
    if (rejection) {
      stop();
      this.unsubBroker = null;
      throw new Error(rejection.message);
    }

    // When clientId was provided to hello, welcome uses that id.
    resolved = asSessionClientId(pendingId);
    this._clientId = resolved;

    // Re-bind: only forward events after connect; hello welcome already delivered.
    return resolved;
  }

  async disconnect(): Promise<void> {
    if (!this._clientId) return;
    await this.broker.dispatch(this._clientId, { type: 'disconnect' });
    this.unsubBroker?.();
    this.unsubBroker = null;
    this._clientId = null;
  }

  async send(command: SessionCommand, commandId?: string): Promise<SessionRejection | null> {
    if (!this._clientId) {
      return {
        code: 'NOT_CONNECTED',
        message: 'Transport is not connected.',
        commandId,
        commandType: command.type,
      };
    }
    this.seq += 1;
    return this.broker.dispatch(this._clientId, command, commandId ?? `cmd:${this.seq}`);
  }

  subscribe(handler: SessionEventHandler): () => void {
    this.handlers.add(handler);
    if (!this.unsubBroker) {
      this.unsubBroker = this.broker.subscribe((envelope) => {
        for (const h of this.handlers) h(envelope);
      });
    }
    return () => {
      this.handlers.delete(handler);
    };
  }
}
