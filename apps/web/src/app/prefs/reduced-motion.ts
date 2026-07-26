import { isPlatformBrowser } from '@angular/common';
import { DOCUMENT, Injectable, PLATFORM_ID, inject, signal } from '@angular/core';

/**
 * Whether the user has asked their system for less motion.
 *
 * CSS can answer this on its own, and the stylesheets do; this exists for the
 * decisions CSS cannot reach — Monaco's own animated caret and smooth scrolling,
 * which are options rather than transitions, and the editor window's slide
 * between layout modes, which is only animated because it helps you follow where
 * the panel went. Someone who has turned motion off does not need help following
 * it, and is often actively harmed by it.
 *
 * A signal rather than a one-off read, because the preference can change while
 * the app is open — and on the server it is simply `false`, which is the same
 * answer the first client render gives, so hydration matches.
 */
@Injectable({ providedIn: 'root' })
export class ReducedMotion {
  private readonly document = inject(DOCUMENT);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  private readonly state = signal(false);

  readonly enabled = this.state.asReadonly();

  constructor() {
    if (!this.isBrowser) return;

    const query = this.document.defaultView?.matchMedia('(prefers-reduced-motion: reduce)');
    if (!query) return;

    this.state.set(query.matches);
    query.addEventListener('change', (event) => this.state.set(event.matches));
  }
}
