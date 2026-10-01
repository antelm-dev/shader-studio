/**
 * Response headers that apply to everything this process serves — the API, the
 * static bundle and the server-rendered app alike.
 *
 * These are the cheap half of transport security. The expensive half is the
 * reverse proxy actually terminating TLS: `Strict-Transport-Security` is a
 * promise about a future request, and a deployment that sends it over plain
 * HTTP has only locked its users out. It is therefore sent in production only,
 * where HTTPS is the deployment's job and documented as such.
 */

import type { NextFunction, Request, Response } from 'express';

export interface SecurityHeaderOptions {
  production: boolean;
  /** Seconds. Two years, the value the HSTS preload list expects. */
  hstsMaxAge?: number;
}

export function securityHeaders(options: SecurityHeaderOptions) {
  const hsts = `max-age=${options.hstsMaxAge ?? 63_072_000}; includeSubDomains`;

  return (_request: Request, response: Response, next: NextFunction): void => {
    // A cookie-authenticated app framed by a third party is a clickjacking
    // target; `frame-ancestors` is the modern spelling and X-Frame-Options the
    // one older browsers still read.
    response.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    response.setHeader('X-Frame-Options', 'DENY');
    // Stops a browser from guessing that a stored texture is really a script.
    response.setHeader('X-Content-Type-Options', 'nosniff');
    // Shader ids live in the path, so a full URL should not travel to a
    // third-party image or font host in a Referer header.
    response.setHeader('Referrer-Policy', 'same-origin');
    // Nothing here uses any of these, and saying so costs one header.
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (options.production) response.setHeader('Strict-Transport-Security', hsts);
    next();
  };
}
