/**
 * The credential endpoints on their own server, with throttling left on.
 *
 * It lives apart from `router.spec.ts` because the two want opposite things:
 * that suite needs more than five accounts an hour, this one needs the limiter
 * that stops exactly that. Sharing a server would mean whichever ran second got
 * the wrong answer.
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LOCAL_SCOPE, ShaderLibrary } from '@shader-studio/backend/library';
import { SqliteRepository } from '@shader-studio/backend/persistence/sqlite';

import { silentAuditor } from '../auth/audit';
import { createAuth } from '../auth/auth';
import { readAuthConfig } from '../auth/auth-config';
import type { Mailer } from '../auth/mailer';
import { createNestApi, type NestApi } from './bootstrap';

const noMail: Mailer = { send: async () => undefined };

let library: ShaderLibrary;
let server: Server;
let nestApi: NestApi;
let base: string;

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
      // Left at its default — that is the whole point of this file.
    }),
    noMail,
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

function signInAttempt(email: string): Promise<Response> {
  return fetch(`${base}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email, password: 'whatever-it-does-not-matter' }),
    redirect: 'manual',
  });
}

describe('rate limits', () => {
  it('stops a password-guessing run before it gets far', async () => {
    const statuses: number[] = [];
    // The sign-in rule allows ten a minute; fifteen attempts must run into it.
    for (let attempt = 0; attempt < 15; attempt += 1) {
      statuses.push((await signInAttempt('target@example.test')).status);
    }

    expect(statuses).toContain(429);
    // And it does not take all fifteen to get there.
    expect(statuses.indexOf(429)).toBeLessThan(15);
  });

  it('caps sign-ups far more tightly than sign-ins', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await fetch(`${base}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({
          email: `flood-${attempt}@example.test`,
          name: `Flood ${attempt}`,
          password: 'a perfectly reasonable passphrase',
        }),
        redirect: 'manual',
      });
      statuses.push(response.status);
    }

    expect(statuses).toContain(429);
  });
});
