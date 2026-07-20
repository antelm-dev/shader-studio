import { RenderMode, ServerRoute } from '@angular/ssr';

/**
 * Server-rendered rather than prerendered: the page reflects whatever shaders
 * are on disk right now, and those change while the app is running.
 */
export const serverRoutes: ServerRoute[] = [
  {
    path: '**',
    renderMode: RenderMode.Server,
  },
];
