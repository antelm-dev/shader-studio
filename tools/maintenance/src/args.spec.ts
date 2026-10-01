import { describe, expect, it } from 'vitest';

import { parseArgs } from './args';

describe('parseArgs', () => {
  it('reads the command and its options', () => {
    expect(parseArgs(['migrate-files', '--source=/legacy', '--mode=overwrite'])).toEqual({
      command: 'migrate-files',
      source: '/legacy',
      email: undefined,
      dryRun: false,
      mode: 'overwrite',
    });
    expect(parseArgs(['claim-shaders', '--email= you@example.com ', '--dry-run'])).toMatchObject({
      command: 'claim-shaders',
      email: 'you@example.com',
      dryRun: true,
    });
  });

  it('falls back to rename for an unknown mode, and keeps the first command', () => {
    expect(parseArgs(['migrate-files', 'extra', '--mode=nuke'])).toMatchObject({
      command: 'migrate-files',
      mode: 'rename',
    });
  });
});
