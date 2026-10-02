/**
 * The identifier shapes a plugin package uses. Kept apart from `package` so the
 * theme references in `themes` — which preferences read — need nothing else of
 * the package contract.
 */

/** A package id: `dev.example.pack`. */
export const PACKAGE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** A contribution id, unique within its package: `amber-dark`. */
export const CONTRIBUTION_ID_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;
