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
 * The session it issues is an ordinary one: it shows up in the account's device
 * list, obeys the same idle and absolute lifetimes, and dies when revoked.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
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
/** The same budget as a password sign-in: ten a minute per address. */
const TOKEN_WINDOW_MS = 60_000;
const TOKEN_MAX = 10;

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
  private readonly limiter = windowLimiter(TOKEN_WINDOW_MS, TOKEN_MAX);

  constructor(
    @Inject(AUTH_INSTANCE) private readonly auth: Auth,
    @Inject(AUDITOR) private readonly auditor: Auditor,
  ) {}

  @ApiOperation({
    summary: 'Issue a desktop sign-in code',
    description:
      'Needs a verified browser (cookie) session. Returns `{ code }`, single-use and valid for 60 s, bound to the S256 `codeChallenge`.',
  })
  @ApiErrors(400)
  @Post('handoff')
  @HttpCode(200)
  async handoff(
    @Body() body: JsonBody,
    @Req() request: Request,
    @CurrentUser() principal: Principal,
  ): Promise<{ code: string }> {
    // Only the browser hands off. A bearer session minting more of itself would
    // let a stolen desktop token outlive its own revocation.
    if (request.headers.authorization) {
      throw new StorageError('unauthorized', 'Sign in from the browser to connect the desktop');
    }
    const codeChallenge = body?.['codeChallenge'];
    if (typeof codeChallenge !== 'string' || !CHALLENGE.test(codeChallenge)) {
      throw new StorageError('invalid', 'Expected an S256 code challenge');
    }
    const code = randomBytes(32).toString('base64url');
    const grant: Grant = { userId: principal.userId, codeChallenge };
    const { internalAdapter } = await this.auth.$context;
    await internalAdapter.createVerificationValue({
      identifier: identifierFor(code),
      value: JSON.stringify(grant),
      expiresAt: new Date(Date.now() + CODE_SECONDS * 1000),
    });
    return { code };
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
    const headers = fromNodeHeaders(request.headers);
    const trustProxy = this.auth.options.advanced?.trustedProxyHeaders === true;
    const context = requestContext(headers, { trustProxy });
    const ip = context.ip ?? request.socket.remoteAddress ?? '';

    if (this.auth.options.rateLimit?.enabled && !this.limiter(ip)) {
      response
        .status(429)
        .json({ error: { code: 'rate_limited', message: 'Too many attempts. Try again later.' } });
      return;
    }

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
