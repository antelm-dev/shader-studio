/**
 * The landing points for the two links we put in emails.
 *
 * Both open the auth dialog over the running app and then send the browser back
 * to `/`, so the token disappears from the address bar (and from anything that
 * would later read it there — history, a shared screenshot, a `Referer`). The
 * editor is never torn down, so an unsaved shader survives the round trip.
 */

import { inject } from '@angular/core';
import type { CanActivateFn } from '@angular/router';
import { Router } from '@angular/router';

import { AuthPrompt, type AuthPromptMode } from './auth-prompt';
import { AuthService } from './auth.service';

function openPrompt(mode: AuthPromptMode): CanActivateFn {
  return (route) => {
    const prompt = inject(AuthPrompt);
    const auth = inject(AuthService);
    const router = inject(Router);

    const token = route.queryParamMap.get('token') ?? undefined;
    prompt.request({ mode, ...(token ? { token } : {}) });
    // A verification link signs the user in server-side, so what the app
    // believes about the session is now out of date.
    if (mode === 'verify-email') void auth.refresh();

    return router.parseUrl('/');
  };
}

export const resetPasswordLink = openPrompt('reset-password');
export const verifyEmailLink = openPrompt('verify-email');
