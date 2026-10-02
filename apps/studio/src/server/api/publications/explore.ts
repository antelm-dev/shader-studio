import type { PublicationLibrary } from '@shadergrove/backend/publication';

import type { Principal } from '../auth/auth';

/** What the API is given about Explore. No `publications` means the feature is off. */
export interface Explore {
  readonly adminUserIds: ReadonlySet<string>;
  readonly publications?: PublicationLibrary;
}

export const EXPLORE_OFF: Explore = { adminUserIds: new Set() };

/** Moderation is granted by the server's own list of account ids, and only to a verified account. */
export function isAdmin(explore: Explore, principal: Principal | null | undefined): boolean {
  return Boolean(principal?.emailVerified && explore.adminUserIds.has(principal.userId));
}
