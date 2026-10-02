import { Injectable, Injector, effect, inject, signal, untracked } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';

import type { ExploreCapabilities } from '@shadergrove/shared/publication';
import { AuthService } from '../auth/auth.service';
import { DesktopPlatform } from '../desktop/desktop-platform';
import { PublicationApi } from './publication-api';

const NONE: ExploreCapabilities = { publicExplore: false, admin: false };

/**
 * Whether this server offers public Explore, and whether the signed-in account
 * moderates it. Every entry point in the app hangs off this, so a server with
 * the feature off — or one that cannot be reached — shows no way in at all.
 *
 * It is a convenience, never an authority: the server checks every request
 * itself. Asked again whenever the session changes, because `admin` belongs to
 * an account, and `admin` is dropped while the answer is on its way so one
 * account's privilege is never on screen for the next.
 *
 * Nothing is fetched during SSR, on the desktop or in the output window: the
 * session is only ever resolved in a browser tab, and this waits for it.
 */
@Injectable({ providedIn: 'root' })
export class ExploreAccess {
  private readonly auth = inject(AuthService);
  private readonly desktop = inject(DesktopPlatform);
  private readonly injector = inject(Injector);

  private readonly state = signal(NONE);
  readonly capabilities = this.state.asReadonly();

  private request = 0;

  constructor() {
    effect(() => {
      const status = this.auth.status();
      this.auth.user();
      if (status === 'loading' || this.desktop.available) return;
      untracked(() => void this.refresh());
    });
  }

  private async refresh(): Promise<void> {
    const request = ++this.request;
    this.state.update((current) => ({ ...current, admin: false }));
    let next = NONE;
    try {
      // Resolved here rather than injected: the desktop build has no HttpClient.
      next = await this.injector.get(PublicationApi).capabilities();
    } catch {
      // Unreachable or older server: no Explore.
    }
    if (request === this.request) this.state.set(next);
  }
}

/** Explore is a web feature: on the desktop its routes lead back to the editor. */
export const exploreOnWeb: CanActivateFn = () =>
  !inject(DesktopPlatform).available || inject(Router).parseUrl('/');
