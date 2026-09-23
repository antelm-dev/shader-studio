/**
 * Turns a `401` from the API into a sign-in prompt instead of an error the user
 * has to decode.
 *
 * It re-resolves the session first — a `401` usually means the session expired
 * or was revoked from another device, and the in-memory state still claims
 * otherwise. The prompt is a dialog rather than a route change on purpose: the
 * editor keeps its unsaved shader, and the user returns to exactly the document
 * they were in the middle of.
 */

import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';

import { AuthService } from './auth.service';
import { AuthPrompt } from './auth-prompt';

export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const auth = inject(AuthService);
  const prompt = inject(AuthPrompt);

  return next(request).pipe(
    catchError((error: unknown) => {
      // Only the app's own API. A 401 from somewhere else is not ours to
      // interpret, and the auth endpoints answer 401 as part of normal use.
      const ours = request.url.includes('/api/') && !request.url.includes('/api/auth/');
      if (error instanceof HttpErrorResponse && error.status === 401 && ours) {
        void auth.refresh().then(() => prompt.requestSignIn());
      }
      return throwError(() => error);
    }),
  );
};
