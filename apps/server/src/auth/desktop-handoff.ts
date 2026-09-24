/**
 * How the desktop app signs in: through the system browser, with PKCE (RFC
 * 8252). A signed-in page asks for a one-time code bound to the desktop's
 * challenge and hands it back through the `shader-studio://` deep link; the
 * desktop trades that code plus its verifier for a session of its own, which it
 * then sends as `Authorization: Bearer` (see the `bearer` plugin in `auth.ts`).
 *
 * The code is worth nothing to whoever intercepts the deep link — another app
 * registered for the scheme, say — because only the desktop holds the verifier.
 * It lives 60 seconds, the first attempt consumes it whatever the outcome, and
 * only its hash is stored. Every failure is the same 400, so the endpoint never
 * says which part was wrong. Neither the code nor the token is ever logged.
 *
 * Issuing a code takes the account password, not just the session cookie. The
 * cookie rides along on any request from our origin, so without that a script
 * injected into the page (XSS) could post its own challenge, trade the code and
 * walk away with a bearer token that outlives the page. The password is the one
 * thing such a script does not have; it is checked by Better Auth's own hasher,
 * and failed guesses are throttled like sign-in.
 *
 * The session it issues is an ordinary one: it shows up in the account's device
 * list, obeys the same idle and absolute lifetimes, and dies when revoked.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Body, Controller, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { fromNodeHeaders } from 'better-auth/node';

import { StorageError } from '@shader-studio/backend/library';

import { AUDITOR, AUTH_INSTANCE } from '../api/api.constants';
import { CurrentUser, Public } from '../api/auth.guard';
import { ApiErrors } from '../api/swagger';
import { requestContext, type Auditor } from './audit';
import type { Auth, Principal } from './auth';

/** What the desktop's sessions are listed as in the account's device list. */
export const DESKTOP_USER_AGENT = 'Shader Studio Desktop';

const CODE_SECONDS = 60;
/** The same budget as a password sign-in, for each endpoint: ten a minute per address. */
const LIMIT_WINDOW_MS = 60_000;
const LIMIT_MAX = 10;

// A SHA-256 digest in unpadded base64url, and RFC 7636's verifier alphabet.
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const CODE = CHALLENGE;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

type JsonBody = Record<string, unknown> | undefined;

interface Grant {
  userId: string;
  codeChallenge: string;
}

@ApiTags('desktop')
@Controller('desktop')
export class DesktopHandoffController {
  private readonly handoffLimiter = windowLimiter(LIMIT_WINDOW_MS, LIMIT_MAX);
  private readonly tokenLimiter = windowLimiter(LIMIT_WINDOW_MS, LIMIT_MAX);

  constructor(
    @Inject(AUTH_INSTANCE) private readonly auth: Auth,
    @Inject(AUDITOR) private readonly auditor: Auditor,
  ) {}

  @ApiOperation({
    summary: 'Issue a desktop sign-in code',
    description:
      'Needs a verified browser (cookie) session and the account password. Returns `{ code }`, single-use and valid for 60 s, bound to the S256 `codeChallenge`.',
  })
  @ApiErrors(400)
  @Post('handoff')
  async handoff(
    @Body() body: JsonBody,
    @Req() request: Request,
    @Res() response: Response,
    @CurrentUser() principal: Principal,
  ): Promise<void> {
    // Only the browser hands off. A bearer session minting more of itself would
    // let a stolen desktop token outlive its own revocation.
    if (request.headers.authorization) {
      throw new StorageError('unauthorized', 'Sign in from the browser to connect the desktop');
    }
    // Counted before the password is looked at, so failed guesses spend it too.
    if (this.throttled(this.handoffLimiter, request, response)) return;

    const codeChallenge = body?.['codeChallenge'];
    const password = body?.['password'];
    if (typeof codeChallenge !== 'string' || !CHALLENGE.test(codeChallenge)) invalidHandoff();
    if (typeof password !== 'string' || !password || password.length > 128) invalidHandoff();

    const context = await this.auth.$context;
    const account = await context.internalAdapter.findCredentialAccount(principal.userId);
    if (!account?.password) {
      // Hashed anyway so an account without a password answers in the same time.
      await context.password.hash(password);
      invalidHandoff();
    }
    if (!(await context.password.verify({ hash: account.password, password }))) invalidHandoff();

    const code = randomBytes(32).toString('base64url');
    const grant: Grant = { userId: principal.userId, codeChallenge };
    await context.internalAdapter.createVerificationValue({
      identifier: identifierFor(code),
      value: JSON.stringify(grant),
      expiresAt: new Date(Date.now() + CODE_SECONDS * 1000),
    });
    response.setHeader('Cache-Control', 'no-store');
    response.status(200).json({ code });
  }

  @ApiOperation({
    summary: 'Exchange a desktop sign-in code for a session',
    description:
      'Returns `{ token, user }`; send the token as `Authorization: Bearer`. Every failure is the same 400.',
  })
  @ApiErrors(400)
  @Public()
  @Post('token')
  async token(
    @Body() body: JsonBody,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const context = this.requestContext(request);
    const ip = this.clientIp(request);
    if (this.throttled(this.tokenLimiter, request, response)) return;

    const code = body?.['code'];
    const verifier = body?.['codeVerifier'];
    if (typeof code !== 'string' || !CODE.test(code)) invalidCode();
    if (typeof verifier !== 'string' || !VERIFIER.test(verifier)) invalidCode();

    const { internalAdapter } = await this.auth.$context;
    // Deleted before anything is checked, so a wrong verifier burns the code
    // too. An expired row is deleted the same way and comes back as `null`.
    const row = await internalAdapter.consumeVerificationValue(identifierFor(code));
    const grant = row ? parseGrant(row.value) : null;
    if (!grant || !sameChallenge(challengeOf(verifier), grant.codeChallenge)) invalidCode();

    const user = await internalAdapter.findUserById(grant.userId);
    if (!user?.emailVerified) invalidCode();

    const session = await internalAdapter.createSession(user.id, false, {
      userAgent: DESKTOP_USER_AGENT,
      ipAddress: ip,
    });
    this.auditor.record('desktop.signed-in', { userId: user.id, ...context });

    // The body is a credential: no cache may keep it.
    response.setHeader('Cache-Control', 'no-store');
    response.status(200).json({
      token: session.token,
      user: { id: user.id, name: user.name, email: user.email },
    });
  }

  private requestContext(request: Request) {
    const trustProxy = this.auth.options.advanced?.trustedProxyHeaders === true;
    return requestContext(fromNodeHeaders(request.headers), { trustProxy });
  }

  private clientIp(request: Request): string {
    return this.requestContext(request).ip ?? request.socket.remoteAddress ?? '';
  }

  /** Answers 429 and returns true once this address has spent its budget. */
  private throttled(
    limiter: (key: string) => boolean,
    request: Request,
    response: Response,
  ): boolean {
    if (!this.auth.options.rateLimit?.enabled || limiter(this.clientIp(request))) return false;
    response
      .status(429)
      .json({ error: { code: 'rate_limited', message: 'Too many attempts. Try again later.' } });
    return true;
  }
}

function invalidHandoff(): never {
  throw new StorageError('invalid', 'Check your password and try again');
}

function invalidCode(): never {
  throw new StorageError('invalid', 'Invalid or expired code');
}

/** Only the code's hash is stored, so a read of the table cannot replay one. */
function identifierFor(code: string): string {
  return `desktop-handoff:${createHash('sha256').update(code).digest('base64url')}`;
}

function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function sameChallenge(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseGrant(value: string): Grant | null {
  try {
    const grant = JSON.parse(value) as Partial<Grant>;
    return typeof grant.userId === 'string' && typeof grant.codeChallenge === 'string'
      ? { userId: grant.userId, codeChallenge: grant.codeChallenge }
      : null;
  } catch {
    return null;
  }
}

/**
 * A fixed-window count per address. The whole map is dropped when the window
 * rolls over, so it never holds more than one window's callers.
 */
// ponytail: per-process; a multi-instance deployment needs a shared store here.
function windowLimiter(windowMs: number, max: number): (key: string) => boolean {
  const hits = new Map<string, number>();
  let resetAt = 0;
  return (key) => {
    const now = Date.now();
    if (now >= resetAt) {
      hits.clear();
      resetAt = now + windowMs;
    }
    const count = (hits.get(key) ?? 0) + 1;
    hits.set(key, count);
    return count <= max;
  };
}
