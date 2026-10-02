import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MAT_DIALOG_DATA } from '@angular/material/dialog';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OwnerPublication, ShaderPublicationStatus } from '@shadergrove/shared/publication';
import { AuthService } from '../auth/auth.service';
import { I18n } from '../i18n/i18n';
import { ShaderStore } from '../workspace/shader-store';
import { PublishDialog } from './publish-dialog';

const STATUS_URL = '/api/shaders/waves/publication';

const publication = (extra: Partial<OwnerPublication> = {}): OwnerPublication => ({
  id: '0123456789abcdef0123',
  title: 'Waves',
  description: '',
  authorLabel: 'Alice A.',
  license: 'MIT',
  revision: 1,
  publishedAt: '2026-09-30T10:00:00.000Z',
  updatedAt: '2026-09-30T10:00:00.000Z',
  hasThumbnail: false,
  attribution: 'Noise by someone',
  derivedFrom: null,
  ownerVisible: true,
  moderatorHidden: false,
  sourceRevision: 4,
  ...extra,
});

const PRIVATE: ShaderPublicationStatus = { publication: null, origin: null, restricted: false };

const dirty = signal(false);
const record = signal({ id: 'waves', revision: 4 });
const store = {
  selectedId: signal('waves'),
  dirty,
  record,
  shaders: signal([{ id: 'waves', revision: 4 }]),
  save: vi.fn(async () => {
    dirty.set(false);
    record.set({ id: 'waves', revision: 5 });
    return true;
  }),
};

async function open(status: ShaderPublicationStatus) {
  dirty.set(false);
  record.set({ id: 'waves', revision: 4 });
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: I18n, useValue: { t: (key: string) => key, locale: signal('en') } },
      { provide: AuthService, useValue: { displayName: () => 'alice' } },
      { provide: ShaderStore, useValue: store },
      { provide: MAT_DIALOG_DATA, useValue: { shaderId: 'waves', name: 'Waves' } },
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  const fixture = TestBed.createComponent(PublishDialog);
  fixture.detectChanges();
  http.expectOne(STATUS_URL).flush(status);
  await settle(fixture);
  return { http, fixture, root: fixture.nativeElement as HTMLElement };
}

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  for (let pass = 0; pass < 2; pass += 1) {
    await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();
    await fixture.whenStable();
  }
}

function button(root: HTMLElement, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find(
    (entry) => entry.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no button "${label}"`);
  return found;
}

const confirmRights = (root: HTMLElement) =>
  (root.querySelector('mat-checkbox input') as HTMLInputElement).click();

afterEach(() => TestBed.resetTestingModule());

describe('PublishDialog', () => {
  it('publishes the saved revision only after the rights are confirmed', async () => {
    const { http, fixture, root } = await open(PRIVATE);
    expect(root.textContent).toContain('publish.statePrivate');
    expect(button(root, 'publish.publish').disabled).toBe(true);

    confirmRights(root);
    await settle(fixture);
    button(root, 'publish.publish').click();
    const request = http.expectOne({ method: 'PUT', url: STATUS_URL });
    expect(request.request.body).toEqual({
      expectedRevision: 4,
      authorLabel: 'alice',
      license: 'CC-BY-4.0',
      attribution: '',
      rightsConfirmed: true,
    });
    request.flush(
      { publication: publication({ authorLabel: 'alice' }) },
      { status: 201, statusText: 'x' },
    );
    await settle(fixture);

    expect(root.textContent).toContain('publish.statePublic');
    expect(root.querySelector('.link a')?.textContent).toContain('/explore/0123456789abcdef0123');
    expect(button(root, 'publish.update')).toBeTruthy();
  });

  it('refuses while the open shader has unsaved edits, and publishes what Save wrote', async () => {
    const { http, fixture, root } = await open(PRIVATE);
    confirmRights(root);
    dirty.set(true);
    await settle(fixture);
    expect(root.textContent).toContain('publish.unsaved');
    expect(button(root, 'publish.publish').disabled).toBe(true);

    button(root, 'action.saveShader').click();
    await settle(fixture);
    expect(root.textContent).not.toContain('publish.unsaved');
    button(root, 'publish.publish').click();
    expect(http.expectOne({ method: 'PUT', url: STATUS_URL }).request.body).toMatchObject({
      expectedRevision: 5,
    });
  });

  it('starts from the current publication and explains a conflict or a takedown', async () => {
    const { http, fixture, root } = await open({
      ...PRIVATE,
      publication: publication({ moderatorHidden: true }),
    });
    expect(root.textContent).toContain('publish.stateHidden');
    // Hidden by a moderator: there is no public link to hand out.
    expect(root.querySelector('.link')).toBeNull();
    expect((root.querySelector('input[matInput]') as HTMLInputElement).value).toBe('Alice A.');
    expect((root.querySelector('select') as HTMLSelectElement).value).toBe('MIT');

    confirmRights(root);
    await settle(fixture);
    button(root, 'publish.update').click();
    http
      .expectOne({ method: 'PUT', url: STATUS_URL })
      .flush({ error: { code: 'conflict', message: 'x' } }, { status: 409, statusText: 'x' });
    await settle(fixture);
    expect(root.textContent).toContain('publish.conflict');
    // Nothing was pretended: the state on screen is still the server's.
    expect(root.textContent).toContain('publish.stateHidden');
  });

  it('unpublishes, keeping the dialog on the publication it now no longer shows', async () => {
    const { http, fixture, root } = await open({ ...PRIVATE, publication: publication() });
    button(root, 'publish.unpublish').click();
    http
      .expectOne({ method: 'DELETE', url: STATUS_URL })
      .flush({ publication: publication({ ownerVisible: false }) });
    await settle(fixture);
    expect(root.textContent).toContain('publish.stateUnpublished');
    expect(root.querySelector('.link')).toBeNull();
    expect(button(root, 'publish.publish')).toBeTruthy();
  });

  it('offers no way to publish from a restricted account', async () => {
    const { root } = await open({ ...PRIVATE, restricted: true });
    expect(root.textContent).toContain('publish.stateRestricted');
    expect(root.querySelector('mat-checkbox')).toBeNull();
    expect([...root.querySelectorAll('button')].map((entry) => entry.textContent?.trim())).toEqual([
      'action.close',
    ]);
  });

  it('holds a copy of a share-alike shader to the same license', async () => {
    const { root } = await open({
      ...PRIVATE,
      origin: {
        publicationId: 'ffffffffffffffffffff',
        title: 'Source',
        authorLabel: 'Bob',
        license: 'CC-BY-SA-4.0',
        attribution: '',
      },
    });
    const select = root.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('CC-BY-SA-4.0');
    expect(select.disabled).toBe(true);
    expect(root.textContent).toContain('publish.shareAlike');
    expect(root.textContent).toContain('explore.basedOn');
  });
});
