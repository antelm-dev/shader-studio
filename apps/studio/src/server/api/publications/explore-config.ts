/**
 * What the public Explore feature reads from the environment.
 *
 * It is off unless `PUBLIC_EXPLORE_ENABLED=1`: with it off the publication and
 * moderation routes are not registered and the web app shows no way in, which
 * is also how the feature is rolled back — the data stays, the doors close.
 *
 * Moderators are named by immutable account id in
 * `PUBLIC_EXPLORE_ADMIN_USER_IDS` (comma separated). An id, not an address: an
 * email can be changed or re-registered, an id cannot. An empty list means
 * nobody moderates. The list never leaves the server.
 */

export interface ExploreConfig {
  readonly enabled: boolean;
  readonly adminUserIds: ReadonlySet<string>;
}

export function readExploreConfig(env: NodeJS.ProcessEnv = process.env): ExploreConfig {
  return {
    enabled: env['PUBLIC_EXPLORE_ENABLED'] === '1',
    adminUserIds: new Set(
      (env['PUBLIC_EXPLORE_ADMIN_USER_IDS'] ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  };
}
