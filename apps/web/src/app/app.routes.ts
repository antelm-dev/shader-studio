import { Routes } from '@angular/router';
import { RouteAnchor } from './ui/layout/route-anchor';
import { resetPasswordLink, verifyEmailLink } from './auth/auth-link.guard';

export const routes: Routes = [
  { path: '', component: RouteAnchor },
  { path: 'shaders/:id', component: RouteAnchor },
  // Where the emails land. Each opens the auth dialog over the running app and
  // redirects to `/`, so the token does not linger in the address bar and the
  // editor is never replaced by a login page.
  { path: 'reset-password', component: RouteAnchor, canActivate: [resetPasswordLink] },
  { path: 'verify-email', component: RouteAnchor, canActivate: [verifyEmailLink] },
  { path: '**', component: RouteAnchor },
];
