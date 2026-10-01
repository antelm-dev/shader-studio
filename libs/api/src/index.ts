/**
 * The HTTP API (`/api/*`): NestJS routes, accounts and the HTTP policy around
 * them. Not a service of its own — apps/web/src/server mounts it beside the SSR
 * handler — but a real boundary all the same: the desktop app signs in and
 * syncs through these routes, so they change as a contract, not as web code.
 *
 * One Nest module per feature (system, shaders, auth, publications, admin),
 * composed by ApiModule; core/ is what they share.
 */

export { createNestApi, type NestApi } from './bootstrap';
export { consoleAuditor, silentAuditor, type Auditor } from './auth/audit';
export { createAuth, type Auth, type Principal } from './auth/auth';
export { AuthConfigError, readAuthConfig, type AuthConfig } from './auth/auth-config';
export type { Mail, Mailer } from './auth/mailer';
export { securityHeaders, type SecurityHeaderOptions } from './core/security-headers';
export { readExploreConfig, type ExploreConfig } from './publications/explore-config';
