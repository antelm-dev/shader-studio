import { describe, expect, it } from 'vitest';

import { capExpiry } from './auth';

describe('capExpiry', () => {
  const createdAt = new Date('2026-01-01T00:00:00Z');
  const day = 24 * 60 * 60;

  it('leaves a refresh inside the absolute lifetime alone', () => {
    const expiresAt = new Date('2026-01-10T00:00:00Z');
    expect(capExpiry(expiresAt, createdAt, 30 * day)).toEqual(expiresAt);
  });

  it('never lets a refresh slide past createdAt + max', () => {
    const expiresAt = new Date('2026-02-20T00:00:00Z');
    expect(capExpiry(expiresAt, createdAt, 30 * day)).toEqual(new Date('2026-01-31T00:00:00Z'));
  });
});
