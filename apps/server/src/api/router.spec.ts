/**
 * REST tests for the NestJS shader API, driven against a real `ShaderLibrary` backed by
 * an in-memory SQLite database. The router is mounted on a live express server
 * and exercised over HTTP, so the request parsing, status-code mapping and error
 * envelope are all covered end-to-end without a filesystem or Postgres.
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ShaderLibrary } from '@shader-studio/backend/library';
import { SqliteRepository } from '@shader-studio/backend/persistence/sqlite';
import { createNestApi, type NestApi } from './bootstrap';

let library: ShaderLibrary;
let server: Server;
let base: string;
let nestApi: NestApi;

beforeAll(async () => {
  library = new ShaderLibrary(new SqliteRepository({ location: ':memory:' }));
  await library.init();
  nestApi = await createNestApi(library);
  const app = express();
  app.use('/api', nestApi.handler);
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await nestApi.app.close();
  await library.close();
});

async function reset(): Promise<void> {
  const list = (await (await fetch(`${base}/api/shaders`)).json()) as { shaders: { id: string }[] };
  for (const shader of list.shaders) {
    await fetch(`${base}/api/shaders/${shader.id}`, { method: 'DELETE' });
  }
}

beforeEach(reset);

describe('shader REST API', () => {
  it('lists, creates and reads shaders', async () => {
    expect(await (await fetch(`${base}/api/shaders`)).json()).toEqual({ shaders: [] });

    const created = await fetch(`${base}/api/shaders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rest Demo' }),
    });
    expect(created.status).toBe(201);
    const { shader } = (await created.json()) as { shader: { id: string; revision: number } };
    expect(shader.id).toBe('rest-demo');
    expect(shader.revision).toBe(1);

    const read = await fetch(`${base}/api/shaders/${shader.id}`);
    expect(read.status).toBe(200);
  });

  it('bumps the revision on update and rejects a stale expectedRevision with 409', async () => {
    const { shader } = (await (
      await fetch(`${base}/api/shaders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Contended' }),
      })
    ).json()) as { shader: { id: string; revision: number } };

    const first = await fetch(`${base}/api/shaders/${shader.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Once', expectedRevision: shader.revision }),
    });
    expect(first.status).toBe(200);

    const stale = await fetch(`${base}/api/shaders/${shader.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Twice', expectedRevision: shader.revision }),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'conflict' },
    });
  });

  it('404s an unknown shader and 400s an invalid create, in the standard error envelope', async () => {
    const missing = await fetch(`${base}/api/shaders/does-not-exist`);
    expect(missing.status).toBe(404);
    expect((await missing.json()) as { error: { code: string; message: string } }).toMatchObject({
      error: { code: 'not_found' },
    });

    const invalid = await fetch(`${base}/api/shaders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  ' }),
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'invalid' },
    });
  });

  it('stores and serves a texture, then clears it', async () => {
    const { shader } = (await (
      await fetch(`${base}/api/shaders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Textured' }),
      })
    ).json()) as { shader: { id: string } };

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const put = await fetch(`${base}/api/shaders/${shader.id}/textures/0?width=2&height=2`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: bytes,
    });
    expect(put.status).toBe(200);

    const got = await fetch(`${base}/api/shaders/${shader.id}/textures/0`);
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);

    const cleared = await fetch(`${base}/api/shaders/${shader.id}/textures/0`, {
      method: 'DELETE',
    });
    expect(cleared.status).toBe(200);
    expect((await fetch(`${base}/api/shaders/${shader.id}/textures/0`)).status).toBe(404);
  });

  it('deletes a shader', async () => {
    const { shader } = (await (
      await fetch(`${base}/api/shaders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Doomed' }),
      })
    ).json()) as { shader: { id: string } };

    const deleted = await fetch(`${base}/api/shaders/${shader.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);
    expect((await fetch(`${base}/api/shaders/${shader.id}`)).status).toBe(404);
  });
});
