import { claimSystemShaders } from '@shadergrove/backend/persistence/postgres';

import { requireDatabaseUrl } from './require-database-url';

/**
 * Hands the shaders that predate authentication — the ones the ownership
 * migration backfilled to the system account — to a real user, who must already
 * have signed up. Bundled examples are left alone: they are templates, and
 * belong to nobody in particular.
 */
export async function claimShaders(email: string, dryRun: boolean): Promise<number> {
  const url = requireDatabaseUrl();
  if (!url) return 2;

  const result = await claimSystemShaders(url, email, { dryRun });
  switch (result.status) {
    case 'no-such-user':
      console.error(
        `error: no account for "${email}". Sign up in the app first, then run this again.`,
      );
      return 1;
    case 'nothing-to-claim':
      console.log('Nothing to claim: no shaders are left under the system account.');
      return 0;
    case 'would-claim':
      console.log(`Would move ${result.count} shader(s) to ${result.owner} <${email}>.`);
      return 0;
    case 'claimed':
      console.log(`Moved ${result.count} shader(s) to ${result.owner} <${email}>.`);
      return 0;
  }
}
