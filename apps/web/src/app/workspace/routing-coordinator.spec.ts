import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import { AuthService } from '../auth/auth.service';
import { I18n } from '../i18n/i18n';
import { WorkspaceActions } from '../ui/workspace-actions';
import { RoutingCoordinator } from './routing-coordinator';
import { ShaderStore } from './shader-store';

@Component({ template: '' })
class Blank {}

async function setup(url: string) {
  const selectedId = signal<string | null>(null);
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([{ path: '**', component: Blank }]),
      {
        provide: ShaderStore,
        useValue: {
          selectedId,
          shaders: signal([{ id: 'waves' }]),
          notice: signal(null),
          initializeClient: async () => undefined,
        },
      },
      {
        provide: WorkspaceActions,
        useValue: {
          selectShader: async () => true,
          resolveStaleRecovery: async () => undefined,
          resolveFirstRunMigration: async () => undefined,
        },
      },
      { provide: I18n, useValue: { t: (key: string) => key } },
      { provide: AuthService, useValue: { status: signal('loading'), user: signal(null) } },
    ],
  });
  const router = TestBed.inject(Router);
  await router.navigateByUrl(url);
  const coordinator = TestBed.inject(RoutingCoordinator);
  // `afterNextRender` never fires without a view; start routing the way it would.
  await (coordinator as unknown as { initializeRouting(): Promise<void> }).initializeRouting();
  return { router, selectedId };
}

const settle = async () => {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
};

describe('RoutingCoordinator', () => {
  it('normalizes an unknown path to the selection', async () => {
    const { router } = await setup('/somewhere');
    expect(router.url).toBe('/');
  });

  it('leaves the desktop sign-in page alone, through startup and a selection', async () => {
    const url = '/desktop/connect?state=af0ifjsldkj-state_1&code_challenge=abc';
    const { router, selectedId } = await setup(url);
    expect(router.url).toBe(url);

    selectedId.set('waves');
    await settle();
    expect(router.url).toBe(url);
  });
});
