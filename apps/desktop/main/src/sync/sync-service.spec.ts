import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOCAL_SCOPE, ShaderLibrary, StorageError } from '@shader-studio/backend/library';
import { SqliteRepository } from '@shader-studio/backend/persistence/sqlite';
import type { SyncChangedEvent } from '@shader-studio/desktop-api/contracts';
import { buildShaderBundle, extFromMime, parseBundle } from '@shader-studio/shared/validate';
import type { AccountSession, AccountState } from '../account/account-session';
import { notifyingWrites, SyncService } from './sync-service';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

/** The account server, reduced to the routes sync uses, over a real library. */
function fakeServer(remote: ShaderLibrary) {
  const server = {
    calls: [] as string[],
    offline: false,
    unauthorized: false,
    /** Runs once the server has handled a request, before the client sees the answer. */
    afterHandled: undefined as ((call: string) => void) | undefined,
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const handle = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? 'GET';
    server.calls.push(`${method} ${path}`);
    if (server.offline) throw new TypeError('fetch failed');
    if (server.unauthorized) return new Response(null, { status: 401 });
    const body = () => JSON.parse(String(init.body)) as Record<string, unknown>;
    try {
      if (method === 'POST' && path === '/api/import') {
        const parsed = parseBundle(body()['bundle']);
        if (!parsed.ok) return json({}, 400);
        return json(await remote.importPayloads(parsed.value, 'rename'), 201);
      }
      const match = /^\/api\/shaders\/([^/]+)(?:\/(\w+))?$/.exec(path);
      if (!match) return json({}, 404);
      const id = decodeURIComponent(match[1]);
      const sub = match[2];
      if (method === 'GET' && !sub) return json({ shader: await remote.read(id) });
      if (method === 'GET' && sub === 'export') {
        return json(buildShaderBundle(await remote.exportOne(id)));
      }
      if (method === 'PUT' && sub === 'bundle') {
        const input = body();
        const parsed = parseBundle(input['bundle']);
        if (!parsed.ok) return json({}, 400);
        const shader = await remote.replaceFromPayload(
          id,
          parsed.value[0],
          input['expectedRevision'],
        );
        return json({ shader });
      }
      if (method === 'PUT' && sub === 'thumbnail') {
        const headers = new Headers(init.headers);
        const shader = await remote.setThumbnail(id, {
          ext: extFromMime(headers.get('content-type')) ?? '',
          bytes: init.body as Uint8Array,
        });
        return json({ shader });
      }
      return json({}, 404);
    } catch (error) {
      if (error instanceof StorageError) {
        return json({}, { not_found: 404, conflict: 409 }[error.code as string] ?? 400);
      }
      throw error;
    }
  };
  const fetch = async (path: string, init?: RequestInit): Promise<Response> => {
    const response = await handle(path, init);
    server.afterHandled?.(server.calls.at(-1)!);
    return response;
  };
  return Object.assign(server, { fetch });
}

function fakeAccount(fetch: AccountSession['fetch'], state: AccountState) {
  const listeners = new Set<(state: AccountState) => void>();
  const account = {
    current: state,
    state: () => account.current,
    onChange: (listener: (state: AccountState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    fetch: async (path: string, init?: RequestInit) => {
      const response = await fetch(path, init);
      if (response.status === 401) account.set({ ...account.current, status: 'reauth-required' });
      return response;
    },
    set(next: AccountState) {
      account.current = next;
      for (const listener of listeners) listener(next);
    },
  };
  return account;
}

const userA: AccountState = {
  status: 'signed-in',
  user: { id: 'user-a', name: 'A', email: 'a@example.test' },
};
const userB: AccountState = {
  status: 'signed-in',
  user: { id: 'user-b', name: 'B', email: 'b@example.test' },
};

describe('SyncService', () => {
  let dir: string;
  let local: ShaderLibrary;
  let remote: ShaderLibrary;
  let server: ReturnType<typeof fakeServer>;
  let account: ReturnType<typeof fakeAccount>;
  let sync: SyncService;
  let last: SyncChangedEvent | undefined;

  const statusOf = async (id: string) => (await sync.snapshot()).statuses[id];
  const links = async (userId = 'user-a') =>
    JSON.parse((await local.getMeta(`sync_links:${userId}`)) ?? '{}') as Record<
      string,
      { remoteId: string; remoteRevision: number; localRevision: number }
    >;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ss-sync-'));
    local = new ShaderLibrary(
      new SqliteRepository({ location: join(dir, 'local.sqlite') }),
      LOCAL_SCOPE,
    );
    remote = new ShaderLibrary(
      new SqliteRepository({ location: join(dir, 'remote.sqlite') }),
      LOCAL_SCOPE,
    );
    await local.init();
    await remote.init();
    server = fakeServer(remote);
    account = fakeAccount(server.fetch, userA);
    sync = new SyncService(local, account, (event) => (last = event));
  });

  afterEach(async () => {
    sync.dispose();
    await local.close();
    await remote.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp dir; the OS reclaims it */
    }
  });

  it('uploads a shader, links it and reports it synced (AC-SYNC-01)', async () => {
    const shader = await local.create({ name: 'Waves' });
    await local.setThumbnail(shader.id, { ext: 'png', bytes: PNG });

    await sync.upload([shader.id]);

    const link = (await links())[shader.id];
    expect(link).toMatchObject({ remoteRevision: 1, localRevision: shader.revision });
    expect((await remote.read(link.remoteId)).name).toBe('Waves');
    expect(await remote.readThumbnail(link.remoteId)).not.toBeNull();
    expect(await statusOf(shader.id)).toBe('synced');
    expect(last?.progress).toBeNull();
  });

  it('uploadAll skips templates and already-linked shaders', async () => {
    const first = await local.create({ name: 'One' });
    await sync.upload([first.id]);
    await local.create({ name: 'Two' });
    server.calls.length = 0;

    await sync.uploadAll();

    expect(server.calls).toEqual(['POST /api/import']);
    expect((await remote.list()).map((s) => s.name).sort()).toEqual(['One', 'Two']);
  });

  it('marks an edit pending and a push clears it (AC-SYNC-02)', async () => {
    const shader = await local.create({ name: 'Edit me' });
    await sync.upload([shader.id]);
    await local.update(shader.id, { fragment: 'void main() { /* local */ }' });
    expect(await statusOf(shader.id)).toBe('pending');

    const events: SyncChangedEvent[] = [];
    const watched = new SyncService(local, account, (event) => events.push(event));
    await watched.run();
    watched.dispose();

    const link = (await links())[shader.id];
    expect((await remote.read(link.remoteId)).fragment).toContain('/* local */');
    expect(link.remoteRevision).toBe(2);
    expect(await statusOf(shader.id)).toBe('synced');
    expect(events.some((event) => event.progress?.total === 1)).toBe(true);
    expect(events.at(-1)?.progress).toBeNull();
  });

  it('pushes a thumbnail-only change on its own', async () => {
    const shader = await local.create({ name: 'Pic' });
    await sync.upload([shader.id]);
    await local.setThumbnail(shader.id, { ext: 'png', bytes: PNG });
    expect(await statusOf(shader.id)).toBe('pending');
    server.calls.length = 0;

    await sync.run();

    const { remoteId } = (await links())[shader.id];
    expect(server.calls).toEqual([`PUT /api/shaders/${remoteId}/thumbnail`]);
    expect(await remote.readThumbnail(remoteId)).not.toBeNull();
    expect(await statusOf(shader.id)).toBe('synced');
  });

  it('keeps both on 409 without losing either side (AC-SYNC-03)', async () => {
    const shader = await local.create({ name: 'Shared' });
    await sync.upload([shader.id]);
    const { remoteId } = (await links())[shader.id];
    await remote.update(remoteId, { fragment: 'void main() { /* web */ }' });
    await local.update(shader.id, { fragment: 'void main() { /* desktop */ }' });

    await sync.run();

    const shaders = await local.list();
    expect(shaders).toHaveLength(2);
    expect((await local.read(shader.id)).fragment).toContain('/* web */');
    const copy = shaders.find((s) => s.id !== shader.id)!;
    expect(copy.name).toBe('Shared (conflict)');
    expect((await local.read(copy.id)).fragment).toContain('/* desktop */');
    expect((await remote.read(remoteId)).fragment).toContain('/* web */');
    expect(await statusOf(shader.id)).toBe('conflict-resolved');
    expect(await statusOf(copy.id)).toBe('local-only');
    expect((await links())[copy.id]).toBeUndefined();

    await local.update(shader.id, { fragment: 'void main() { /* next */ }' });
    expect(await statusOf(shader.id)).toBe('pending');
    await sync.run();
    expect((await remote.read(remoteId)).fragment).toContain('/* next */');
  });

  it('unlinks on 404 and keeps the local shader (AC-SYNC-05)', async () => {
    const shader = await local.create({ name: 'Gone' });
    await sync.upload([shader.id]);
    await remote.remove((await links())[shader.id].remoteId);
    await local.update(shader.id, { fragment: 'void main() { /* kept */ }' });

    await sync.run();

    expect((await links())[shader.id]).toBeUndefined();
    expect((await local.read(shader.id)).fragment).toContain('/* kept */');
    expect(await statusOf(shader.id)).toBe('local-only');
  });

  it('stops on 401 and keeps the dirty links (AC-SYNC-05)', async () => {
    const one = await local.create({ name: 'One' });
    const two = await local.create({ name: 'Two' });
    await sync.upload([one.id, two.id]);
    await local.update(one.id, { fragment: 'void main() { /* 1 */ }' });
    await local.update(two.id, { fragment: 'void main() { /* 2 */ }' });
    const before = await links();
    server.unauthorized = true;
    server.calls.length = 0;

    await sync.run();

    expect(server.calls).toHaveLength(1);
    expect(await links()).toEqual(before);
    expect((await local.read(one.id)).fragment).toContain('/* 1 */');
    expect(await statusOf(one.id)).toBe('reauth-required');

    server.unauthorized = false;
    account.set(userA);
    await sync.run();
    expect(await statusOf(one.id)).toBe('synced');
    expect(await statusOf(two.id)).toBe('synced');
  });

  it('keeps edits pending while offline', async () => {
    const shader = await local.create({ name: 'Offline' });
    await sync.upload([shader.id]);
    await local.update(shader.id, { fragment: 'void main() { /* offline */ }' });
    server.offline = true;

    await sync.run();

    expect(await statusOf(shader.id)).toBe('pending');
    server.offline = false;
    await sync.run();
    expect(await statusOf(shader.id)).toBe('synced');
  });

  it("never pushes another account's links (AC-SYNC-04)", async () => {
    const shader = await local.create({ name: 'Mine' });
    await sync.upload([shader.id]);
    await local.update(shader.id, { fragment: 'void main() { /* A */ }' });
    account.set(userB);
    await sync.run();
    server.calls.length = 0;

    await sync.run();
    await sync.upload([shader.id]);

    expect(server.calls).toEqual([]);
    expect(await statusOf(shader.id)).toBe('other-account');
    expect(await links('user-b')).toEqual({});
  });

  it('clears the local thumbnail when the account version has none', async () => {
    const shader = await local.create({ name: 'Bare' });
    await sync.upload([shader.id]);
    const { remoteId } = (await links())[shader.id];
    await remote.update(remoteId, { fragment: 'void main() { /* web */ }' });
    await local.update(shader.id, { fragment: 'void main() { /* desktop */ }' });
    await local.setThumbnail(shader.id, { ext: 'png', bytes: PNG });

    const events: SyncChangedEvent[] = [];
    const watched = new SyncService(local, account, (event) => events.push(event));
    await watched.run();
    expect((await watched.snapshot()).statuses[shader.id]).toBe('conflict-resolved');
    watched.dispose();

    expect(await local.readThumbnail(shader.id)).toBeNull();
    const copy = (await local.list()).find((s) => s.id !== shader.id)!;
    expect(copy.thumbnail).not.toBeNull();
    expect((await links())[shader.id].localThumbnail).toBeNull();
    await vi.waitFor(() => expect(events.some((e) => e.replaced?.includes(shader.id))).toBe(true));
  });

  it('stops an upload when another account signs in mid-batch (AC-SYNC-04)', async () => {
    const one = await local.create({ name: 'One' });
    await local.create({ name: 'Two' });
    server.afterHandled = (call) => {
      if (call === 'POST /api/import') account.set(userB);
    };

    await sync.uploadAll();

    expect(server.calls).toEqual(['POST /api/import']);
    expect(await links('user-a')).toEqual({});
    expect(await links('user-b')).toEqual({});
    expect(await statusOf(one.id)).toBe('local-only');
  });

  it('stops a push when another account signs in mid-run (AC-SYNC-04)', async () => {
    const one = await local.create({ name: 'One' });
    const two = await local.create({ name: 'Two' });
    await sync.upload([one.id, two.id]);
    await local.update(one.id, { fragment: 'void main() { /* 1 */ }' });
    await local.update(two.id, { fragment: 'void main() { /* 2 */ }' });
    const before = await links();
    server.calls.length = 0;
    server.afterHandled = (call) => {
      if (call.endsWith('/bundle')) account.set(userB);
    };

    await sync.run();

    expect(server.calls.filter((call) => call.endsWith('/bundle'))).toHaveLength(1);
    expect(await links('user-a')).toEqual(before);
    expect(await links('user-b')).toEqual({});
  });

  it('shows no statuses without a signed-in account', async () => {
    await local.create({ name: 'Solo' });
    account.set({ status: 'signed-out' });
    expect((await sync.snapshot()).statuses).toEqual({});
  });

  it('runs once for two triggers at once', async () => {
    const shader = await local.create({ name: 'Once' });
    await sync.upload([shader.id]);
    await local.update(shader.id, { fragment: 'void main() { /* once */ }' });
    server.calls.length = 0;

    await Promise.all([sync.run(), sync.run()]);

    expect(server.calls).toHaveLength(1);
  });

  it('notifies after a write through the IPC-facing library', async () => {
    let writes = 0;
    const wrapped = notifyingWrites(local, () => writes++);
    const shader = await wrapped.create({ name: 'Hook' });
    await wrapped.list();
    await wrapped.update(shader.id, { description: 'x' });
    expect(writes).toBe(2);
  });
});
