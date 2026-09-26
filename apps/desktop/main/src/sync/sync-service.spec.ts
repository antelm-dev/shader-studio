import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOCAL_SCOPE, ShaderLibrary, StorageError } from '@shader-studio/backend/library';
import { SqliteRepository } from '@shader-studio/backend/persistence/sqlite';
import type { SyncChangedEvent, SyncRemoveMode } from '@shader-studio/desktop-api/contracts';
import { buildShaderBundle, extFromMime, parseBundle } from '@shader-studio/shared/validate';
import type { AccountState } from '../account/account-session';
import { notifyingWrites, SyncService } from './sync-service';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

/** The account server, reduced to the routes sync uses, over a real library. */
function fakeServer(remote: ShaderLibrary) {
  const server = {
    calls: [] as string[],
    offline: false,
    unauthorized: false,
    /** Runs once the server has handled a request, before the client sees the answer. */
    afterHandled: undefined as ((call: string) => void | Promise<void>) | undefined,
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const handle = async (path: string, init: RequestInit = {}, user?: string): Promise<Response> => {
    const method = init.method ?? 'GET';
    server.calls.push(`${method} ${path}`);
    if (server.offline) throw new TypeError('fetch failed');
    if (server.unauthorized) return new Response(null, { status: 401 });
    // `remote` is user A's account; any other account is empty.
    if (user !== 'user-a') return method === 'GET' ? json({ shaders: [] }) : json({}, 404);
    const body = () => JSON.parse(String(init.body)) as Record<string, unknown>;
    try {
      if (method === 'GET' && path === '/api/shaders')
        return json({ shaders: await remote.list() });
      if (method === 'POST' && path === '/api/import') {
        const parsed = parseBundle(body()['bundle']);
        if (!parsed.ok) return json({}, 400);
        return json(await remote.importPayloads(parsed.value, 'rename'), 201);
      }
      const [route, query] = path.split('?');
      const match = /^\/api\/shaders\/([^/]+)(?:\/(\w+))?$/.exec(route);
      if (!match) return json({}, 404);
      const id = decodeURIComponent(match[1]);
      const sub = match[2];
      if (method === 'DELETE' && !sub) {
        const expected = new URLSearchParams(query).get('expectedRevision');
        await remote.remove(id, expected === null ? undefined : Number(expected));
        return new Response(null, { status: 204 });
      }
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
  const fetch = async (path: string, init?: RequestInit, user?: string): Promise<Response> => {
    const response = await handle(path, init, user);
    await server.afterHandled?.(server.calls.at(-1)!);
    return response;
  };
  return Object.assign(server, { fetch });
}

function fakeAccount(
  fetch: (path: string, init: RequestInit | undefined, user?: string) => Promise<Response>,
  state: AccountState,
) {
  const listeners = new Set<(state: AccountState) => void>();
  const account = {
    current: state,
    state: () => account.current,
    onChange: (listener: (state: AccountState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    fetch: async (path: string, init?: RequestInit) => {
      const response = await fetch(path, init, account.current.user?.id);
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
    expect(server.calls).toEqual(['GET /api/shaders', `PUT /api/shaders/${remoteId}/thumbnail`]);
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

    expect(server.calls).toEqual(['GET /api/shaders']);
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

  it('keeps an upload already sent, then stops, when another account signs in (AC-SYNC-04)', async () => {
    const one = await local.create({ name: 'One' });
    const two = await local.create({ name: 'Two' });
    server.afterHandled = (call) => {
      if (call === 'POST /api/import') account.set(userB);
    };

    await sync.uploadAll();

    // One request, sent for A: its result is A's link, so A never re-imports it.
    expect(server.calls).toEqual(['POST /api/import']);
    const [imported] = await remote.list();
    const linked = await links('user-a');
    expect(Object.keys(linked)).toHaveLength(1);
    expect([one.id, two.id]).toContain(Object.keys(linked)[0]);
    expect(Object.values(linked)[0].remoteId).toBe(imported.id);
    expect(await links('user-b')).toEqual({});

    server.afterHandled = undefined;
    account.set(userA);
    server.calls.length = 0;
    await sync.uploadAll();
    // The sign-in's own run only reads the list: one import, never a duplicate.
    expect(server.calls).toEqual(['GET /api/shaders', 'POST /api/import']);
    expect(await remote.list()).toHaveLength(2);
  });

  it('keeps a push already sent, then stops, when another account signs in (AC-SYNC-04)', async () => {
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

    const bundles = server.calls.filter((call) => call.endsWith('/bundle'));
    expect(server.calls).toEqual(['GET /api/shaders', ...bundles]);
    expect(bundles).toHaveLength(1);
    const after = await links();
    const pushed = [one.id, two.id].find((id) => bundles[0].includes(before[id].remoteId))!;
    const other = pushed === one.id ? two.id : one.id;
    expect(after[pushed].remoteRevision).toBe(2);
    expect(after[other]).toEqual(before[other]);
    expect(await links('user-b')).toEqual({});

    // Back on A: the recorded revision holds, so no spurious 409 and no copy.
    server.afterHandled = undefined;
    account.set(userA);
    await sync.run();
    expect(await local.list()).toHaveLength(2);
    expect(await statusOf(one.id)).toBe('synced');
    expect(await statusOf(two.id)).toBe('synced');
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

    expect(server.calls.filter((call) => call === 'GET /api/shaders')).toHaveLength(1);
  });

  describe('pull (C4)', () => {
    const exports = () => server.calls.filter((call) => call.endsWith('/export'));
    const watch = () => {
      const events: SyncChangedEvent[] = [];
      const watched = new SyncService(local, account, (event) => events.push(event));
      return { watched, events };
    };

    it('pulls a shader created on the web, linked and synced (AC-PULL-01)', async () => {
      const mine = await local.create({ name: 'Web' });
      const web = await remote.create({ name: 'Web' });
      await remote.update(web.id, { fragment: 'void main() { /* web */ }' });
      await remote.setThumbnail(web.id, { ext: 'png', bytes: PNG });

      await sync.run();

      const pulled = (await local.list()).find((s) => s.id !== mine.id)!;
      expect((await local.read(pulled.id)).fragment).toContain('/* web */');
      expect(await local.readThumbnail(pulled.id)).not.toBeNull();
      expect((await links())[pulled.id]).toMatchObject({ remoteId: web.id, remoteRevision: 2 });
      expect(await statusOf(pulled.id)).toBe('synced');
      expect(await statusOf(mine.id)).toBe('local-only');

      server.calls.length = 0;
      await sync.run();
      expect(server.calls).toEqual(['GET /api/shaders']);
    });

    it('pulls a web edit with its thumbnail, then a removed thumbnail (AC-PULL-02, AC-PULL-05)', async () => {
      const shader = await local.create({ name: 'Edited' });
      await sync.upload([shader.id]);
      const { remoteId } = (await links())[shader.id];
      await remote.update(remoteId, { fragment: 'void main() { /* web */ }' });
      await remote.setThumbnail(remoteId, { ext: 'png', bytes: PNG });
      const { watched, events } = watch();

      await watched.run();

      expect((await local.read(shader.id)).fragment).toContain('/* web */');
      expect(await local.readThumbnail(shader.id)).not.toBeNull();
      expect(await statusOf(shader.id)).toBe('synced');
      await vi.waitFor(() =>
        expect(events.some((e) => e.replaced?.includes(shader.id))).toBe(true),
      );
      expect(events.some((e) => e.progress?.total === 1)).toBe(true);

      await remote.update(remoteId, { fragment: 'void main() { /* bare */ }' });
      await remote.clearThumbnail(remoteId);
      await watched.run();
      watched.dispose();

      expect((await local.read(shader.id)).fragment).toContain('/* bare */');
      expect(await local.readThumbnail(shader.id)).toBeNull();
      expect(await statusOf(shader.id)).toBe('synced');
      server.calls.length = 0;
      await sync.run();
      expect(server.calls).toEqual(['GET /api/shaders']);
    });

    describe('a local write during the download', () => {
      const LOCAL_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);
      const during = (write: () => Promise<unknown>) => {
        server.afterHandled = async (call) => {
          if (!call.endsWith('/export')) return;
          server.afterHandled = undefined;
          await write();
        };
      };

      it('keeps a content save pending over a thumbnail-only pull', async () => {
        const shader = await local.create({ name: 'Original' });
        await sync.upload([shader.id]);
        const { remoteId } = (await links())[shader.id];
        await remote.setThumbnail(remoteId, { ext: 'png', bytes: PNG });
        during(() => local.update(shader.id, { name: 'Concurrent edit' }));

        await sync.run();

        expect(await local.readThumbnail(shader.id)).not.toBeNull();
        expect(await statusOf(shader.id)).toBe('pending');
        await sync.run();
        expect((await remote.read(remoteId)).name).toBe('Concurrent edit');
        expect(await statusOf(shader.id)).toBe('synced');
      });

      it('keeps and pushes a local thumbnail set during a thumbnail pull', async () => {
        const shader = await local.create({ name: 'Pic' });
        await sync.upload([shader.id]);
        const { remoteId } = (await links())[shader.id];
        await remote.setThumbnail(remoteId, { ext: 'png', bytes: PNG });
        during(() => local.setThumbnail(shader.id, { ext: 'png', bytes: LOCAL_PNG }));

        await sync.run();

        expect((await local.readThumbnail(shader.id))?.bytes).toEqual(LOCAL_PNG);
        expect(await statusOf(shader.id)).toBe('pending');
        await sync.run();
        expect((await remote.readThumbnail(remoteId))?.bytes).toEqual(LOCAL_PNG);
        expect(await statusOf(shader.id)).toBe('synced');
      });

      it('keeps a local thumbnail saved right before the pulled one is written', async () => {
        const shader = await local.create({ name: 'Last moment' });
        await sync.upload([shader.id]);
        const { remoteId } = (await links())[shader.id];
        await remote.setThumbnail(remoteId, { ext: 'png', bytes: PNG });
        // The renderer's save commits between the download and the sync's write.
        const setThumbnail = local.setThumbnail.bind(local);
        const spy = vi
          .spyOn(local, 'setThumbnail')
          .mockImplementationOnce(async (id, input, expected) => {
            await setThumbnail(id, { ext: 'png', bytes: LOCAL_PNG });
            return setThumbnail(id, input, expected);
          });

        await sync.run();
        spy.mockRestore();

        expect((await local.readThumbnail(shader.id))?.bytes).toEqual(LOCAL_PNG);
        expect(await statusOf(shader.id)).toBe('pending');
        await sync.run();
        expect((await remote.readThumbnail(remoteId))?.bytes).toEqual(LOCAL_PNG);
        expect(await statusOf(shader.id)).toBe('synced');
      });

      it('keeps a local thumbnail cleared and recreated in the same millisecond', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
          vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
          const shader = await local.create({ name: 'Recreated' });
          await local.setThumbnail(shader.id, { ext: 'png', bytes: PNG });
          await sync.upload([shader.id]);
          const { remoteId } = (await links())[shader.id];
          await remote.setThumbnail(remoteId, { ext: 'png', bytes: PNG });
          during(async () => {
            await local.clearThumbnail(shader.id);
            await local.setThumbnail(shader.id, { ext: 'png', bytes: LOCAL_PNG });
          });

          await sync.run();

          expect((await local.readThumbnail(shader.id))?.bytes).toEqual(LOCAL_PNG);
          expect(await statusOf(shader.id)).toBe('pending');
          await sync.run();
          expect((await remote.readThumbnail(remoteId))?.bytes).toEqual(LOCAL_PNG);
          expect(await statusOf(shader.id)).toBe('synced');
        } finally {
          vi.useRealTimers();
        }
      });

      it('never acknowledges a content save during a content pull', async () => {
        const shader = await local.create({ name: 'Race' });
        await sync.upload([shader.id]);
        const { remoteId } = (await links())[shader.id];
        await remote.update(remoteId, { fragment: 'void main() { /* web */ }' });
        during(() => local.update(shader.id, { fragment: 'void main() { /* local */ }' }));

        await sync.run();

        expect((await local.read(shader.id)).fragment).toContain('/* local */');
        expect(await statusOf(shader.id)).not.toBe('synced');
        await sync.run();
        const copy = (await local.list()).find((s) => s.id !== shader.id)!;
        expect((await local.read(copy.id)).fragment).toContain('/* local */');
        expect((await local.read(shader.id)).fragment).toContain('/* web */');
        expect(await statusOf(shader.id)).toBe('conflict-resolved');
      });
    });

    it('pulls a thumbnail-only web change without touching the content', async () => {
      const shader = await local.create({ name: 'Pic' });
      await sync.upload([shader.id]);
      const { remoteId } = (await links())[shader.id];
      await remote.setThumbnail(remoteId, { ext: 'png', bytes: PNG });
      const before = await local.read(shader.id);
      server.calls.length = 0;
      const { watched, events } = watch();

      await watched.run();
      watched.dispose();

      expect(server.calls).toEqual(['GET /api/shaders', `GET /api/shaders/${remoteId}/export`]);
      expect(await local.readThumbnail(shader.id)).not.toBeNull();
      expect((await local.read(shader.id)).revision).toBe(before.revision);
      expect(events.some((e) => e.replaced)).toBe(false);
      expect(await statusOf(shader.id)).toBe('synced');
    });

    it('does not pull back a thumbnail it just pushed', async () => {
      const shader = await local.create({ name: 'Mine' });
      await sync.upload([shader.id]);
      await local.setThumbnail(shader.id, { ext: 'png', bytes: PNG });
      await sync.run();
      server.calls.length = 0;

      await sync.run();

      expect(server.calls).toEqual(['GET /api/shaders']);
    });

    it('shows a shader deleted on the web as local-only and keeps it (AC-PULL-03)', async () => {
      const shader = await local.create({ name: 'Deleted on web' });
      await sync.upload([shader.id]);
      await remote.remove((await links())[shader.id].remoteId);
      server.calls.length = 0;

      await sync.run();

      expect(server.calls).toEqual(['GET /api/shaders']);
      expect((await links())[shader.id]).toBeUndefined();
      expect((await local.read(shader.id)).name).toBe('Deleted on web');
      expect(await statusOf(shader.id)).toBe('local-only');
    });

    it('never pulls an ignored remote id (AC-PULL-03)', async () => {
      const web = await remote.create({ name: 'Ignored' });
      await local.setMeta('sync_ignored:user-a', JSON.stringify([web.id]));

      await sync.run();

      expect(exports()).toEqual([]);
      expect(await local.list()).toEqual([]);
    });

    it('ignores the remote id of a linked shader deleted here', async () => {
      const shader = await local.create({ name: 'Deleted here' });
      await sync.upload([shader.id]);
      const { remoteId } = (await links())[shader.id];
      await local.remove(shader.id);

      await sync.run();
      await sync.run();

      expect(await links()).toEqual({});
      expect(JSON.parse((await local.getMeta('sync_ignored:user-a'))!)).toEqual([remoteId]);
      expect(await local.list()).toEqual([]);
      expect(exports()).toEqual([]);
      expect((await remote.read(remoteId)).name).toBe('Deleted here');
    });

    it('keeps a pull already sent, then stops, when another account signs in (AC-PULL-04)', async () => {
      await remote.create({ name: 'One' });
      await remote.create({ name: 'Two' });
      server.afterHandled = (call) => {
        if (call.endsWith('/export')) account.set(userB);
      };

      await sync.run();

      expect(exports()).toHaveLength(1);
      expect(server.calls).toEqual(['GET /api/shaders', ...exports()]);
      expect(await local.list()).toHaveLength(1);
      expect(Object.keys(await links())).toHaveLength(1);
      expect(await links('user-b')).toEqual({});
    });

    it('pulls the thumbnail of an older link once', async () => {
      const shader = await local.create({ name: 'Old link' });
      await sync.upload([shader.id]);
      const { remoteThumbnail: _, ...old } = (await links())[shader.id] as Record<string, unknown>;
      await local.setMeta('sync_links:user-a', JSON.stringify({ [shader.id]: old }));
      server.calls.length = 0;

      await sync.run();
      await sync.run();

      expect(exports()).toHaveLength(1);
      expect((await links())[shader.id]).toHaveProperty('remoteThumbnail', null);
      expect(await statusOf(shader.id)).toBe('synced');
    });

    it('is synced only once a run found it on the account', async () => {
      const shader = await local.create({ name: 'Checked' });
      await sync.upload([shader.id]);
      const { watched } = watch();
      expect((await watched.snapshot()).statuses[shader.id]).toBe('pending');

      server.offline = true;
      await watched.run();
      expect((await watched.snapshot()).statuses[shader.id]).toBe('pending');

      server.offline = false;
      await watched.run();
      expect((await watched.snapshot()).statuses[shader.id]).toBe('synced');
      watched.dispose();
    });

    it('merges timer and focus triggers into one run (AC-PULL-04)', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
      try {
        const { watched } = watch();
        const run = vi.spyOn(watched, 'run');
        const gets = () => server.calls.filter((call) => call === 'GET /api/shaders').length;

        // Timer, focus and a manual trigger at once: one run.
        vi.advanceTimersByTime(60_000);
        watched.focused();
        expect(run).toHaveBeenCalledTimes(2);
        await watched.run();
        expect(gets()).toBe(1);

        // Focus runs at most once every 15 s.
        vi.advanceTimersByTime(10_000);
        watched.focused();
        expect(run).toHaveBeenCalledTimes(3);
        vi.advanceTimersByTime(5_000);
        watched.focused();
        expect(run).toHaveBeenCalledTimes(4);
        await watched.run();

        // Signed out: neither the timer nor focus runs.
        account.set({ status: 'signed-out' });
        run.mockClear();
        vi.advanceTimersByTime(120_000);
        watched.focused();
        expect(run).not.toHaveBeenCalled();
        watched.dispose();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('deletion (C5)', () => {
    const tombstones = async (userId = 'user-a') =>
      JSON.parse((await local.getMeta(`sync_tombstones:${userId}`)) ?? '[]') as unknown[];
    const ignored = async () =>
      JSON.parse((await local.getMeta('sync_ignored:user-a')) ?? '[]') as string[];
    const intents = async () =>
      JSON.parse((await local.getMeta('sync_local_deletes')) ?? '[]') as unknown[];
    const deletes = () => server.calls.filter((call) => call.startsWith('DELETE '));
    const linked = async (name: string) => {
      const shader = await local.create({ name });
      await sync.upload([shader.id]);
      return { id: shader.id, remoteId: (await links())[shader.id].remoteId };
    };
    /** A delete as the renderer sends it: the account and revision on screen now. */
    const request = async (id: string, mode: SyncRemoveMode, userId = 'user-a') => ({
      id,
      mode,
      userId,
      revision: (await local.read(id)).revision,
    });
    const remove = async (id: string, mode: SyncRemoveMode, service = sync) =>
      service.remove(await request(id, mode));

    it('"Delete from this computer" keeps the account copy, never pulled back (AC-DEL-01)', async () => {
      const { id, remoteId } = await linked('Here only');

      expect(await remove(id, 'local')).toBe('ok');
      await sync.run();

      expect(await local.list()).toEqual([]);
      expect(await links()).toEqual({});
      expect(await ignored()).toEqual([remoteId]);
      expect(await intents()).toEqual([]);
      expect((await remote.read(remoteId)).name).toBe('Here only');
      expect(deletes()).toEqual([]);
      expect(server.calls.filter((call) => call.endsWith('/export'))).toEqual([]);
    });

    it('"Delete everywhere" deletes the account copy on the next run (AC-DEL-02)', async () => {
      const { id, remoteId } = await linked('Everywhere');
      server.calls.length = 0;

      expect(await remove(id, 'everywhere')).toBe('ok');
      await sync.run();

      expect(deletes()).toEqual([`DELETE /api/shaders/${remoteId}?expectedRevision=1`]);
      expect(await remote.list()).toEqual([]);
      expect(await local.list()).toEqual([]);
      expect(await tombstones()).toEqual([]);
      expect(await ignored()).toEqual([]);
    });

    it('"Delete everywhere" offline deletes here now and on the account once back (AC-DEL-02)', async () => {
      const { id, remoteId } = await linked('Offline');
      server.offline = true;

      await remove(id, 'everywhere');
      await sync.run();

      expect(await local.list()).toEqual([]);
      expect(await tombstones()).toHaveLength(1);
      expect((await remote.read(remoteId)).name).toBe('Offline');

      server.offline = false;
      await sync.run();
      expect(await remote.list()).toEqual([]);
      expect(await tombstones()).toEqual([]);
      expect(await local.list()).toEqual([]);
    });

    it('pulls back an account copy changed since the last sync, with a notice (AC-DEL-03)', async () => {
      const { id, remoteId } = await linked('Changed online');
      await remote.update(remoteId, { fragment: 'void main() { /* web */ }' });
      const events: SyncChangedEvent[] = [];
      const watched = new SyncService(local, account, (event) => events.push(event));

      await remove(id, 'everywhere', watched);
      await watched.run();

      expect(deletes()).toEqual([]);
      expect((await remote.read(remoteId)).fragment).toContain('/* web */');
      const shaders = await local.list();
      expect(shaders).toHaveLength(1);
      const [back] = shaders;
      expect((await local.read(back.id)).fragment).toContain('/* web */');
      expect((await links())[back.id]).toMatchObject({ remoteId, remoteRevision: 2 });
      expect(await tombstones()).toEqual([]);
      expect((await watched.snapshot()).statuses[back.id]).toBe('synced');
      await vi.waitFor(() =>
        expect(events.flatMap((e) => e.notices ?? [])).toEqual([
          { kind: 'restored-after-delete', name: 'Changed online' },
        ]),
      );
      watched.dispose();
    });

    it('pulls back an account copy whose thumbnail alone changed (AC-DEL-03)', async () => {
      const { id, remoteId } = await linked('New picture');
      await remote.setThumbnail(remoteId, { ext: 'png', bytes: PNG });

      await remove(id, 'everywhere');
      await sync.run();

      expect(deletes()).toEqual([]);
      const [back] = await local.list();
      expect(await local.readThumbnail(back.id)).not.toBeNull();
      expect((await links())[back.id]).toMatchObject({ remoteId });
    });

    it('pulls back an account copy the server refuses to delete (409)', async () => {
      const { id, remoteId } = await linked('Raced');
      server.afterHandled = async (call) => {
        if (call !== 'GET /api/shaders') return;
        server.afterHandled = undefined;
        await remote.update(remoteId, { fragment: 'void main() { /* web */ }' });
      };

      await remove(id, 'everywhere');
      await sync.run();

      expect(deletes()).toHaveLength(1);
      expect(await tombstones()).toEqual([]);
      const [back] = await local.list();
      expect((await local.read(back.id)).fragment).toContain('/* web */');
    });

    it('drops a delete the account already did (not listed, or 404)', async () => {
      const one = await linked('Already gone');
      const two = await linked('Gone meanwhile');
      await remote.remove(one.remoteId);
      server.offline = true;
      await remove(one.id, 'everywhere');
      await remove(two.id, 'everywhere');
      server.offline = false;
      server.afterHandled = async (call) => {
        if (call !== 'GET /api/shaders') return;
        server.afterHandled = undefined;
        await remote.remove(two.remoteId);
      };

      await sync.run();

      expect(deletes()).toEqual([`DELETE /api/shaders/${two.remoteId}?expectedRevision=1`]);
      expect(await tombstones()).toEqual([]);
      expect(await local.list()).toEqual([]);
      expect(last?.notices).toBeUndefined();
    });

    it('keeps a delete the account failed, and neither pulls nor unlinks its shader', async () => {
      const { id, remoteId } = await linked('Server error');
      const fetch = account.fetch;
      vi.spyOn(account, 'fetch').mockImplementation(async (path, init) =>
        init?.method === 'DELETE' ? new Response(null, { status: 500 }) : fetch(path, init),
      );

      await remove(id, 'everywhere');
      await sync.run();

      expect(await tombstones()).toHaveLength(1);
      expect(await local.list()).toEqual([]);
      expect(await ignored()).toEqual([]);
      expect((await remote.read(remoteId)).name).toBe('Server error');
    });

    it('keeps tombstones per account across a switch', async () => {
      const { id, remoteId } = await linked('Per account');
      server.offline = true;
      await remove(id, 'everywhere');
      server.offline = false;
      server.calls.length = 0;

      account.set(userB);
      await sync.run();

      expect(deletes()).toEqual([]);
      expect(await tombstones('user-b')).toEqual([]);
      expect(await tombstones()).toHaveLength(1);

      account.set(userA);
      await sync.run();
      expect(deletes()).toEqual([`DELETE /api/shaders/${remoteId}?expectedRevision=1`]);
      expect(await remote.list()).toEqual([]);
    });

    it('keeps a delete already sent, then stops, when another account signs in', async () => {
      const one = await linked('One');
      const two = await linked('Two');
      server.offline = true;
      await remove(one.id, 'everywhere');
      await remove(two.id, 'everywhere');
      server.offline = false;
      server.calls.length = 0;
      server.afterHandled = (call) => {
        if (call.startsWith('DELETE ')) account.set(userB);
      };

      await sync.run();

      // One delete sent for A, then only B's sign-in run, which has nothing queued.
      expect(deletes()).toEqual([`DELETE /api/shaders/${one.remoteId}?expectedRevision=1`]);
      expect(await tombstones()).toEqual([expect.objectContaining({ remoteId: two.remoteId })]);
      expect((await remote.list()).map((s) => s.id)).toEqual([two.remoteId]);
    });

    it('answers not-linked for a shader linked to another account, changing nothing', async () => {
      const { id, remoteId } = await linked('Not yours');
      account.set(userB);
      await sync.run();

      expect(await sync.remove(await request(id, 'everywhere', 'user-b'))).toBe('not-linked');
      expect(await sync.remove(await request(id, 'local', 'user-b'))).toBe('not-linked');

      expect((await local.read(id)).name).toBe('Not yours');
      expect((await links())[id]).toMatchObject({ remoteId });
      expect(await tombstones()).toEqual([]);
      expect(await tombstones('user-b')).toEqual([]);
    });

    it('deletes nothing when another account signed in while the delete waited', async () => {
      const { id, remoteId } = await linked('Switched');
      await remote.update(remoteId, { fragment: 'void main() { /* web */ }' });
      const confirmed = await request(id, 'everywhere');
      let removal: Promise<string> | undefined;
      server.afterHandled = (call) => {
        if (!call.endsWith('/export')) return;
        server.afterHandled = undefined;
        removal = sync.remove(confirmed);
        account.set(userB);
      };

      await sync.run();

      expect(await removal).toBe('account-changed');
      expect((await local.read(id)).name).toBe('Switched');
      expect((await links())[id]).toMatchObject({ remoteId });
      expect(await tombstones()).toEqual([]);
      expect(await intents()).toEqual([]);
    });

    it('deletes nothing when the shader was edited while the delete waited', async () => {
      const { id, remoteId } = await linked('Edited');
      const confirmed = await request(id, 'everywhere');
      await local.update(id, { fragment: 'void main() { /* newer */ }' });

      expect(await sync.remove(confirmed)).toBe('changed');

      expect((await local.read(id)).fragment).toContain('/* newer */');
      expect((await links())[id]).toMatchObject({ remoteId });
      expect(await tombstones()).toEqual([]);
      expect(await intents()).toEqual([]);
    });

    it.each(['local', 'everywhere'] as const)(
      'puts the account state back when an edit lands right before the "%s" delete',
      async (mode) => {
        const { id, remoteId } = await linked('Last second');
        const before = await links();
        const libraryRemove = local.remove.bind(local);
        vi.spyOn(local, 'remove').mockImplementationOnce(async (target, expected) => {
          await local.update(id, { fragment: 'void main() { /* last second */ }' });
          return libraryRemove(target, expected);
        });

        expect(await remove(id, mode)).toBe('changed');

        expect((await local.read(id)).fragment).toContain('/* last second */');
        expect(await links()).toEqual(before);
        expect(await tombstones()).toEqual([]);
        expect(await ignored()).toEqual([]);
        expect(await intents()).toEqual([]);
        await sync.run();
        expect((await remote.read(remoteId)).fragment).toContain('/* last second */');
      },
    );

    it('finishes a local delete a crash interrupted, unless edited since', async () => {
      const done = await linked('Interrupted');
      const kept = await linked('Edited after');
      // The crash: intents and account state written, local shaders not deleted yet.
      const { revision } = await local.read(done.id);
      const { revision: old } = await local.read(kept.id);
      await local.setMeta(
        'sync_local_deletes',
        JSON.stringify([
          { localId: done.id, localRevision: revision },
          { localId: kept.id, localRevision: old },
        ]),
      );
      await local.setMeta(
        'sync_tombstones:user-a',
        JSON.stringify([
          { remoteId: done.remoteId, remoteRevision: 1, remoteThumbnail: null, name: 'x' },
          { remoteId: kept.remoteId, remoteRevision: 1, remoteThumbnail: null, name: 'y' },
        ]),
      );
      await local.setMeta('sync_links:user-a', '{}');
      await local.update(kept.id, { fragment: 'void main() { /* after */ }' });
      sync.dispose();
      sync = new SyncService(local, account, (event) => (last = event));

      await sync.run();

      expect((await local.list()).map((s) => s.id)).toEqual([kept.id]);
      expect((await local.read(kept.id)).fragment).toContain('/* after */');
      expect(await statusOf(kept.id)).toBe('local-only');
      expect(await remote.list()).toEqual([]);
      expect(await intents()).toEqual([]);
    });

    it('waits for a run pulling the shader, then removes it for good', async () => {
      const { id, remoteId } = await linked('Mid-pull');
      await remote.update(remoteId, { fragment: 'void main() { /* web */ }' });
      let removal: Promise<string> | undefined;
      server.afterHandled = async (call) => {
        if (!call.endsWith('/export')) return;
        server.afterHandled = undefined;
        removal = sync.remove(await request(id, 'local'));
      };

      await sync.run();
      // The pull moved the revision on after the request: the pulled edit wins.
      expect(await removal).toBe('changed');
      expect(await remove(id, 'local')).toBe('ok');

      expect(await local.list()).toEqual([]);
      expect(await links()).toEqual({});
      expect(await ignored()).toEqual([remoteId]);
    });
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
