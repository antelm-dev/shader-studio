/** The OpenAPI document is generated from decorators, so it can only break at runtime. */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { LOCAL_SCOPE, ShaderLibrary } from '@shader-studio/backend/library';
import { SqliteRepository } from '@shader-studio/backend/persistence/sqlite';
import { silentAuditor } from '../auth/audit';
import { createAuth } from '../auth/auth';
import { readAuthConfig } from '../auth/auth-config';
import { createNestApi, type NestApi } from './bootstrap';

let library: ShaderLibrary;
let server: Server;
let base: string;
let nestApi: NestApi;

beforeAll(async () => {
  const repo = new SqliteRepository({ location: ':memory:' });
  library = new ShaderLibrary(repo, LOCAL_SCOPE);
  await library.init();
  const app = express();
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = createAuth(
    repo.authDatabase(),
    readAuthConfig({
      NODE_ENV: 'test',
      BETTER_AUTH_SECRET: 'test-secret-not-used-anywhere-real',
      BETTER_AUTH_URL: base,
      AUTH_TRUSTED_ORIGINS: base,
      AUTH_CHECK_COMPROMISED_PASSWORDS: '0',
      AUTH_RATE_LIMIT: '0',
    }),
    { send: async () => undefined },
    silentAuditor,
  );
  nestApi = await createNestApi(library, auth, silentAuditor);
  app.use('/api', nestApi.handler);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await nestApi.app.close();
  await library.close();
});

it('serves an OpenAPI document covering the shader routes', async () => {
  const response = await fetch(`${base}/api/docs-json`);
  expect(response.status).toBe(200);

  const doc = (await response.json()) as {
    paths: Record<string, Record<string, { summary?: string; responses: Record<string, unknown> }>>;
  };
  expect(Object.keys(doc.paths)).toEqual(
    expect.arrayContaining(['/shaders', '/shaders/{id}', '/import', '/i18n/{locale}']),
  );
  expect(doc.paths['/shaders']?.['post']?.summary).toBe('Create a shader');
  expect(doc.paths['/shaders/{id}']?.['put']?.responses['409']).toBeDefined();
});

it('serves the Swagger UI', async () => {
  const response = await fetch(`${base}/api/docs`);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('Shader Studio API');
});
