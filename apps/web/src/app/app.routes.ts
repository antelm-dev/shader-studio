import { Routes } from '@angular/router';
import { AdminPublicationsPage } from './admin/admin-publications-page';
import { RouteAnchor } from './ui/layout/route-anchor';
import { resetPasswordLink, verifyEmailLink } from './auth/auth-link.guard';
import { DesktopConnect, desktopConnectLink } from './auth/desktop-connect';
import { exploreOnWeb } from './publications/explore-access';
import { ExplorePage } from './publications/explore-page';
import { PublicationPage } from './publications/publication-page';

export const routes: Routes = [
  { path: '', component: RouteAnchor },
  { path: 'shaders/:id', component: RouteAnchor },
  // Where the emails land. Each opens the auth dialog over the running app and
  // redirects to `/`, so the token does not linger in the address bar and the
  // editor is never replaced by a login page.
  { path: 'reset-password', component: RouteAnchor, canActivate: [resetPasswordLink] },
  { path: 'verify-email', component: RouteAnchor, canActivate: [verifyEmailLink] },
  // Where the desktop app sends the system browser to sign in.
  { path: 'desktop/connect', component: DesktopConnect, canActivate: [desktopConnectLink] },
  // Public shaders: pages of their own, laid over the editor rather than
  // replacing it (see `RoutingCoordinator.onStandalonePage`). Not lazy on
  // purpose. The coordinator pulls the URL back to the selection as soon as the
  // library has loaded, unless the router is already on one of these — and a
  // page still waiting for its chunk would not be there yet.
  { path: 'explore', component: ExplorePage, canActivate: [exploreOnWeb] },
  { path: 'explore/:publicationId', component: PublicationPage, canActivate: [exploreOnWeb] },
  // Reachable by anyone, useful to nobody but a moderator: the page fetches
  // nothing until the server has said the account is one.
  { path: 'admin/publications', component: AdminPublicationsPage, canActivate: [exploreOnWeb] },
  // Locally installed plugins, on web and desktop alike: laid over the editor like Explore,
  // so the shader an effect is added to stays open underneath. Lazy, unlike Explore —
  // it carries the plugin host and package validation, which nobody else needs at startup;
  // the coordinator reads the navigation in flight, so the chunk's delay is safe.
  {
    path: 'plugins',
    loadComponent: () => import('./plugins/plugins-page').then((m) => m.PluginsPage),
  },
  { path: '**', component: RouteAnchor },
];
