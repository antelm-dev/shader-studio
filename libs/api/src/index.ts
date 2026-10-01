/**
 * The HTTP API (`/api/*`): NestJS routes, accounts and the HTTP policy around
 * them. Not a service of its own — apps/web/server mounts it beside the SSR
 * handler — but a real boundary all the same: the desktop app signs in and
 * syncs through these routes, so they change as a contract, not as web code.
 */

export { createNestApi, type NestApi } from './api/bootstrap';
export { consoleAuditor, silentAuditor, type Auditor } from './auth/audit';
export { createAuth, type Auth, type Principal } from './auth/auth';
export { AuthConfigError, readAuthConfig, type AuthConfig } from './auth/auth-config';
export type { Mail, Mailer } from './auth/mailer';
export { readExploreConfig, type ExploreConfig } from './publication/explore-config';
export { securityHeaders, type SecurityHeaderOptions } from './security-headers';
