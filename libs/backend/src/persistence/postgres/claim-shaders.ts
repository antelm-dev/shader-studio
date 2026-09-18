/**
 * Hands the shaders that predate authentication to a real account.
 *
 * The ownership migration backfilled every existing row to the system owner,
 * because a migration cannot know which human it belongs to. A deployment
 * decides that afterwards, deliberately, by running this once.
 *
 * Templates are excluded by `kind`, so the bundled examples are never quietly
 * handed to whoever claims first — and a second run is harmless, because by
 * then nothing is left under the system account.
 */

import { Pool } from 'pg';

import { SYSTEM_OWNER_ID } from '../user-scope';

export type ClaimResult =
  | { status: 'no-such-user' }
  | { status: 'nothing-to-claim' }
  | { status: 'claimed'; owner: string; count: number }
  | { status: 'would-claim'; owner: string; count: number };

export async function claimSystemShaders(
  connectionString: string,
  email: string,
  options: { dryRun?: boolean } = {},
): Promise<ClaimResult> {
  const pool = new Pool({ connectionString });
  try {
    // Addresses are matched case-insensitively, the same way signing in does.
    const owners = await pool.query<{ id: string; name: string }>(
      'SELECT id, name FROM users WHERE lower(email) = lower($1)',
      [email],
    );
    const user = owners.rows[0];
    if (!user) return { status: 'no-such-user' };

    const claimable = await pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM shaders WHERE owner_user_id = $1 AND kind <> 'template'",
      [SYSTEM_OWNER_ID],
    );
    const count = Number(claimable.rows[0]?.count ?? 0);
    if (count === 0) return { status: 'nothing-to-claim' };
    if (options.dryRun) return { status: 'would-claim', owner: user.name, count };

    const moved = await pool.query(
      "UPDATE shaders SET owner_user_id = $1 WHERE owner_user_id = $2 AND kind <> 'template'",
      [user.id, SYSTEM_OWNER_ID],
    );
    return { status: 'claimed', owner: user.name, count: moved.rowCount ?? 0 };
  } finally {
    await pool.end();
  }
}
