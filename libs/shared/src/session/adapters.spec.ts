import { describe, expect, it, vi } from 'vitest';

import { SessionBroker } from './broker';
import {
  attachSessionBrokerToBroadcastChannel,
  BroadcastChannelSessionTransport,
} from './adapters/broadcast-channel';
import { InProcessSessionTransport } from './adapters/in-process';
import { asSessionClientId, createSessionId } from './ids';
import { SESSION_IPC_CHANNELS } from './transport';

describe('session transport seams', () => {
  it('exposes stable Electron IPC channel names', () => {
    expect(SESSION_IPC_CHANNELS.command).toBe('session:command');
    expect(SESSION_IPC_CHANNELS.event).toBe('session:event');
  });

  it('shares one broker across two in-process clients', async () => {
    const broker = new SessionBroker({ sessionId: createSessionId('ipc') });
    const controller = new InProcessSessionTransport({
      broker,
      role: 'controller',
      clientId: asSessionClientId('main'),
    });
    const editor = new InProcessSessionTransport({
      broker,
      role: 'editor',
      clientId: asSessionClientId('sat'),
    });

    await controller.connect();
    await editor.connect();

    expect(
      await controller.send({
        type: 'replaceDraft',
        shaderId: 'x',
        documents: [
          {
            documentId: 'image',
            kind: 'pass',
            name: 'Image',
            language: 'glsl',
            source: 'a',
            viewState: null,
          },
        ],
        openDocumentIds: ['image'],
        activeDocumentId: 'image',
        params: {},
      }),
    ).toBeNull();

    expect(await editor.send({ type: 'claimOwnership', documentId: 'image' })).toBeNull();
    expect(broker.getSnapshot().documents['image']?.ownerClientId).toBe('sat');
  });
});

describe('BroadcastChannelSessionTransport', () => {
  it('is a no-op host attach when BroadcastChannel is missing', () => {
    const g = globalThis as { BroadcastChannel?: unknown };
    const original = g.BroadcastChannel;
    g.BroadcastChannel = undefined;
    const broker = new SessionBroker({ sessionId: createSessionId('bc') });
    const dispose = attachSessionBrokerToBroadcastChannel(broker);
    expect(() => dispose()).not.toThrow();
    g.BroadcastChannel = original;
  });

  it('round-trips hello over a mock BroadcastChannel when available', async () => {
    class MockChannel {
      static instances: MockChannel[] = [];
      onmessage: ((ev: { data: unknown }) => void) | null = null;
      constructor(readonly name: string) {
        MockChannel.instances.push(this);
      }
      postMessage(data: unknown) {
        for (const peer of MockChannel.instances) {
          if (peer === this) continue;
          peer.onmessage?.({ data });
        }
      }
      close() {
        MockChannel.instances = MockChannel.instances.filter((c) => c !== this);
      }
    }

    const g = globalThis as { BroadcastChannel?: unknown };
    const had = 'BroadcastChannel' in globalThis && g.BroadcastChannel !== undefined;
    const previous = g.BroadcastChannel;
    g.BroadcastChannel = MockChannel;

    try {
      MockChannel.instances = [];
      const broker = new SessionBroker({ sessionId: createSessionId('bc') });
      const dispose = attachSessionBrokerToBroadcastChannel(broker, 'test-session');
      const client = new BroadcastChannelSessionTransport({
        sessionId: broker.sessionId,
        role: 'observer',
        clientId: asSessionClientId('bc-client'),
        channelName: 'test-session',
      });

      const id = await client.connect();
      expect(id).toBe('bc-client');
      expect(broker.getSnapshot().clients.some((c) => c.clientId === 'bc-client')).toBe(true);

      await client.disconnect();
      dispose();
    } finally {
      if (had) {
        g.BroadcastChannel = previous;
      } else {
        g.BroadcastChannel = undefined;
      }
      MockChannel.instances = [];
    }
  });
});

describe('InProcessSessionTransport connect failures', () => {
  it('surfaces protocol mismatch as a thrown error', async () => {
    const broker = new SessionBroker({ sessionId: createSessionId('fail') });
    const spy = vi.spyOn(broker, 'dispatch').mockResolvedValue({
      code: 'PROTOCOL_MISMATCH',
      message: 'bad version',
      supportedProtocolVersions: [1],
    });
    const transport = new InProcessSessionTransport({
      broker,
      role: 'editor',
      clientId: asSessionClientId('x'),
    });
    await expect(transport.connect()).rejects.toThrow('bad version');
    spy.mockRestore();
  });
});
