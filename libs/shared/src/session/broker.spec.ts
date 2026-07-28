import { beforeEach, describe, expect, it } from 'vitest';

import { SessionBroker } from './broker';
import { InProcessSessionTransport } from './adapters/in-process';
import { asSessionClientId, createSessionId, resetSessionIdCounters } from './ids';
import { SESSION_PROTOCOL_VERSION } from './version';
import type { SessionEvent, SessionEventEnvelope, SessionRejection } from './types';

function collectEvents(broker: SessionBroker): SessionEvent[] {
  const events: SessionEvent[] = [];
  broker.subscribe((envelope) => {
    events.push(envelope.event);
  });
  return events;
}

async function connect(
  broker: SessionBroker,
  role: 'controller' | 'editor' | 'observer',
  clientId: string,
) {
  const transport = new InProcessSessionTransport({
    broker,
    role,
    clientId: asSessionClientId(clientId),
    label: clientId,
  });
  await transport.connect();
  return transport;
}

async function seedDraft(broker: SessionBroker, controllerId: string) {
  const transport = await connect(broker, 'controller', controllerId);
  const rejection = await transport.send({
    type: 'replaceDraft',
    shaderId: 'demo',
    documents: [
      {
        documentId: 'image',
        kind: 'pass',
        name: 'Image',
        language: 'glsl',
        source: 'void main() {}\n',
        viewState: null,
      },
      {
        documentId: 'vertex',
        kind: 'vertex',
        name: 'Vertex',
        language: 'glsl',
        source: 'void main() {}\n',
        viewState: null,
      },
    ],
    openDocumentIds: ['image', 'vertex'],
    activeDocumentId: 'image',
    params: { speed: 1 },
    draftMeta: { controlsText: '[]', render: {} },
    dirty: false,
  });
  expect(rejection).toBeNull();
  return transport;
}

describe('SessionBroker', () => {
  beforeEach(() => {
    resetSessionIdCounters();
  });

  it('negotiates protocol and welcomes two clients with one snapshot authority', async () => {
    const broker = new SessionBroker({ sessionId: createSessionId('t') });
    const events = collectEvents(broker);

    const a = await connect(broker, 'controller', 'client-a');
    const b = await connect(broker, 'editor', 'client-b');

    expect(a.clientId).toBe('client-a');
    expect(b.clientId).toBe('client-b');

    const welcomes = events.filter((e) => e.type === 'welcome');
    expect(welcomes).toHaveLength(2);
    expect(
      welcomes.every((e) => e.type === 'welcome' && e.protocolVersion === SESSION_PROTOCOL_VERSION),
    ).toBe(true);
    expect(
      broker
        .getSnapshot()
        .clients.map((c) => c.clientId)
        .sort(),
    ).toEqual(['client-a', 'client-b']);
  });

  it('rejects hello with a mismatched protocol version', async () => {
    const broker = new SessionBroker({ sessionId: createSessionId('t') });
    const rejection = await broker.dispatch(null, {
      type: 'hello',
      protocolVersion: 999,
      role: 'editor',
      clientId: asSessionClientId('bad'),
    });
    expect(rejection?.code).toBe('PROTOCOL_MISMATCH');
    expect(rejection?.supportedProtocolVersions).toEqual([SESSION_PROTOCOL_VERSION]);
  });

  it('rejects stale document edits with current revision and document state', async () => {
    const broker = new SessionBroker({ sessionId: createSessionId('t') });
    const controller = await seedDraft(broker, 'ctrl');
    const editor = await connect(broker, 'editor', 'ed');

    expect(await editor.send({ type: 'claimOwnership', documentId: 'image' })).toBeNull();

    const first = await editor.send({
      type: 'editDocument',
      documentId: 'image',
      baseRevision: 0,
      source: 'void main(){/*1*/}\n',
    });
    expect(first).toBeNull();
    expect(broker.getSnapshot().documents['image']?.revision).toBe(1);

    const stale = await editor.send({
      type: 'editDocument',
      documentId: 'image',
      baseRevision: 0,
      source: 'void main(){/*stale*/}\n',
    });
    expect(stale).toMatchObject<Partial<SessionRejection>>({
      code: 'STALE_REVISION',
      currentRevision: 1,
    });
    expect(stale?.document?.source).toContain('/*1*/');
    expect(broker.getSnapshot().documents['image']?.source).toContain('/*1*/');

    void controller;
  });

  it('enforces one writable owner and allows observers to subscribe only', async () => {
    const broker = new SessionBroker({ sessionId: createSessionId('t') });
    await seedDraft(broker, 'ctrl');
    const editorA = await connect(broker, 'editor', 'ed-a');
    const editorB = await connect(broker, 'editor', 'ed-b');
    const observer = await connect(broker, 'observer', 'obs');

    expect(await editorA.send({ type: 'claimOwnership', documentId: 'image' })).toBeNull();
    expect((await editorB.send({ type: 'claimOwnership', documentId: 'image' }))?.code).toBe(
      'ALREADY_OWNED',
    );
    expect((await observer.send({ type: 'claimOwnership', documentId: 'image' }))?.code).toBe(
      'UNAUTHORIZED',
    );
    expect(
      (
        await observer.send({
          type: 'editDocument',
          documentId: 'image',
          baseRevision: 0,
          source: 'x',
        })
      )?.code,
    ).toBe('UNAUTHORIZED');

    // Observer may request resync.
    expect(await observer.send({ type: 'requestResync', reason: 'test' })).toBeNull();
  });

  it('releases ownership on disconnect without deleting text', async () => {
    const broker = new SessionBroker({ sessionId: createSessionId('t') });
    await seedDraft(broker, 'ctrl');
    const editor = await connect(broker, 'editor', 'ed');

    expect(await editor.send({ type: 'claimOwnership', documentId: 'image' })).toBeNull();
    expect(
      await editor.send({
        type: 'editDocument',
        documentId: 'image',
        baseRevision: 0,
        source: 'kept source\n',
      }),
    ).toBeNull();

    await editor.disconnect();

    const snap = broker.getSnapshot();
    expect(snap.documents['image']?.ownerClientId).toBeNull();
    expect(snap.documents['image']?.source).toBe('kept source\n');
    expect(snap.clients.find((c) => c.clientId === 'ed')).toBeUndefined();
  });

  it('transfers ownership across clients with view state', async () => {
    const broker = new SessionBroker({ sessionId: createSessionId('t') });
    await seedDraft(broker, 'ctrl');
    const editorA = await connect(broker, 'editor', 'ed-a');
    const editorB = await connect(broker, 'editor', 'ed-b');
    const events = collectEvents(broker);

    expect(await editorA.send({ type: 'claimOwnership', documentId: 'image' })).toBeNull();
    expect(
      await editorA.send({
        type: 'moveDocument',
        documentId: 'image',
        targetClientId: asSessionClientId('ed-b'),
        viewState: { cursor: { line: 2, column: 4 } },
      }),
    ).toBeNull();

    const ownership = events.filter((e) => e.type === 'ownershipChanged').at(-1);
    expect(ownership).toMatchObject({
      type: 'ownershipChanged',
      documentId: 'image',
      ownerClientId: 'ed-b',
      viewState: { cursor: { line: 2, column: 4 } },
    });

    expect(
      (
        await editorA.send({
          type: 'editDocument',
          documentId: 'image',
          baseRevision: 0,
          source: 'from-a',
        })
      )?.code,
    ).toBe('NOT_OWNER');

    expect(
      await editorB.send({
        type: 'editDocument',
        documentId: 'image',
        baseRevision: 0,
        source: 'from-b\n',
      }),
    ).toBeNull();
    expect(broker.getSnapshot().documents['image']?.source).toBe('from-b\n');
  });

  it('serializes save and revert and restores snapshot text', async () => {
    const broker = new SessionBroker({ sessionId: createSessionId('t') });
    const controller = await seedDraft(broker, 'ctrl');
    const editor = await connect(broker, 'editor', 'ed');

    expect(await editor.send({ type: 'claimOwnership', documentId: 'image' })).toBeNull();
    expect(
      await editor.send({
        type: 'editDocument',
        documentId: 'image',
        baseRevision: 0,
        source: 'dirty\n',
      }),
    ).toBeNull();
    expect(broker.getSnapshot().dirty).toBe(true);

    // Concurrent save+revert: both go through the broker queue.
    const savePromise = controller.send({ type: 'save' });
    const revertWhileSaving = controller.send({ type: 'revert' });
    const [saveResult, revertResult] = await Promise.all([savePromise, revertWhileSaving]);
    expect(saveResult).toBeNull();
    // Second command may succeed after save completes (dirty false, checkpoint updated)
    // or see SAVE_IN_PROGRESS if it overlapped the saving flag window.
    expect(revertResult === null || revertResult?.code === 'SAVE_IN_PROGRESS').toBe(true);

    expect(
      await editor.send({
        type: 'editDocument',
        documentId: 'image',
        baseRevision: broker.getSnapshot().documents['image']!.revision,
        source: 'dirtier\n',
      }),
    ).toBeNull();
    expect(broker.getSnapshot().dirty).toBe(true);

    expect(await controller.send({ type: 'revert' })).toBeNull();
    const after = broker.getSnapshot();
    expect(after.dirty).toBe(false);
    expect(after.documents['image']?.source).toBe('dirty\n');
    expect(after.documents['image']?.ownerClientId).toBe('ed');
  });

  it('rejects stale parameter updates with a recovery snapshot', async () => {
    const broker = new SessionBroker({ sessionId: createSessionId('t') });
    const controller = await seedDraft(broker, 'ctrl');

    expect(
      await controller.send({ type: 'setParam', baseRevision: 0, key: 'speed', value: 2 }),
    ).toBeNull();
    expect(broker.getSnapshot().paramsRevision).toBe(1);

    const stale = await controller.send({
      type: 'setParams',
      baseRevision: 0,
      params: { speed: 9 },
    });
    expect(stale?.code).toBe('STALE_REVISION');
    expect(stale?.snapshot?.params.speed).toBe(2);
    expect(broker.getSnapshot().params.speed).toBe(2);
  });

  it('recovers via requestResync after reconnect', async () => {
    const broker = new SessionBroker({ sessionId: createSessionId('t') });
    await seedDraft(broker, 'ctrl');
    const editor = await connect(broker, 'editor', 'ed');
    expect(await editor.send({ type: 'claimOwnership', documentId: 'image' })).toBeNull();
    expect(
      await editor.send({
        type: 'editDocument',
        documentId: 'image',
        baseRevision: 0,
        source: 'after-edit\n',
      }),
    ).toBeNull();
    await editor.disconnect();

    const envelopes: SessionEventEnvelope[] = [];
    const reconnected = new InProcessSessionTransport({
      broker,
      role: 'editor',
      clientId: asSessionClientId('ed'),
    });
    reconnected.subscribe((e) => envelopes.push(e));
    await reconnected.connect();

    const welcome = envelopes.find((e) => e.event.type === 'welcome');
    expect(welcome?.event.type).toBe('welcome');
    if (welcome?.event.type === 'welcome') {
      expect(welcome.event.snapshot.documents['image']?.source).toBe('after-edit\n');
      expect(welcome.event.snapshot.documents['image']?.ownerClientId).toBeNull();
    }

    expect(await reconnected.send({ type: 'requestResync' })).toBeNull();
    const resync = envelopes.filter(
      (e) => e.event.type === 'snapshot' && e.event.reason === 'resync',
    );
    expect(resync.length).toBeGreaterThanOrEqual(1);
  });

  it('applies patchDocument edits atomically against baseRevision', async () => {
    const broker = new SessionBroker({ sessionId: createSessionId('t') });
    await seedDraft(broker, 'ctrl');
    const editor = await connect(broker, 'editor', 'ed');
    expect(await editor.send({ type: 'claimOwnership', documentId: 'image' })).toBeNull();

    expect(
      await editor.send({
        type: 'patchDocument',
        documentId: 'image',
        baseRevision: 0,
        edits: [{ start: 0, end: 0, text: '// hi\n' }],
      }),
    ).toBeNull();
    expect(broker.getSnapshot().documents['image']?.source.startsWith('// hi\n')).toBe(true);
    expect(broker.getSnapshot().documents['image']?.revision).toBe(1);
  });

  it('times out silent clients and releases ownership', async () => {
    let now = 1_000;
    const broker = new SessionBroker({
      sessionId: createSessionId('t'),
      heartbeatTimeoutMs: 100,
      now: () => now,
    });
    await seedDraft(broker, 'ctrl');
    const editor = await connect(broker, 'editor', 'ed');
    expect(await editor.send({ type: 'claimOwnership', documentId: 'image' })).toBeNull();

    now = 1_250;
    broker.sweepHeartbeats();

    expect(broker.getSnapshot().documents['image']?.ownerClientId).toBeNull();
    expect(broker.getSnapshot().clients.map((c) => c.clientId)).not.toContain('ed');
  });
});
