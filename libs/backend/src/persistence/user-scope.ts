/**
 * Who a storage call is made on behalf of.
 *
 * Every ownership-sensitive repository method takes a scope as its first
 * argument and folds `owner_user_id = scope.userId` straight into the SQL, so a
 * caller cannot reach another user's shader even by guessing its id — an
 * unknown shader and someone else's shader are indistinguishable (both 404).
 * Nested rows (presets, assets) carry no owner of their own: every path to them
 * first loads the parent shader through a scoped read inside the same
 * transaction, which is the authorization boundary.
 */
export interface UserScope {
  readonly userId: string;
}

/**
 * The owner of rows that predate authentication and of the bundled examples.
 * A deployment reassigns the pre-existing rows to a real account (see
 * `shader-studio claim-shaders`); the examples stay here as templates.
 */
export const SYSTEM_OWNER_ID = 'system';

/** The single implicit user of the offline desktop application. */
export const LOCAL_USER_ID = 'local';

export const SYSTEM_SCOPE: UserScope = { userId: SYSTEM_OWNER_ID };
export const LOCAL_SCOPE: UserScope = { userId: LOCAL_USER_ID };

/**
 * `shader` is a document in someone's library. `template` is a read-only
 * example: editing one produces a copy owned by the editor. The column exists
 * so an accidentally unscoped query cannot quietly turn a private shader into a
 * public one — publicness is a marker, never the absence of an owner.
 */
export type ShaderKind = 'shader' | 'template';
