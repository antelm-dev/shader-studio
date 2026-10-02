import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  AdminPublicationSummary,
  AdminReport,
  ModerationAuditEntry,
} from '@shadergrove/shared/publication';
import { AuthService, type AuthStatus } from '../auth/auth.service';
import { I18n } from '../i18n/i18n';
import { ExploreAccess } from '../publications/explore-access';
import { AdminPublicationsPage } from './admin-publications-page';

const ID = '0123456789abcdef0123';
const LIST = '/api/admin/publications';
const MODERATION = `${LIST}/${ID}/moderation`;

const publication = (extra: Partial<AdminPublicationSummary> = {}): AdminPublicationSummary => ({
  id: ID,
  title: 'Aurora',
  description: '',
  authorLabel: 'Alice A.',
  license: 'CC-BY-4.0',
  revision: 1,
  publishedAt: '2026-09-30T10:00:00.000Z',
  updatedAt: '2026-09-30T10:00:00.000Z',
  hasThumbnail: false,
  ownerUserId: 'user-alice',
  ownerVisible: true,
  moderatorHidden: false,
  moderationRevision: 1,
  openReports: 0,
  publisherRestricted: false,
  ...extra,
});

const report = (id: string, extra: Partial<AdminReport> = {}): AdminReport => ({
  id,
  publicationId: ID,
  publicationTitle: 'Aurora',
  reporterUserId: 'user-bob',
  reason: 'copyright',
  body: 'Mine',
  createdAt: '2026-09-30T11:00:00.000Z',
  status: 'open',
  revision: 1,
  resolvedAt: null,
  resolution: null,
  ...extra,
});

const entry: ModerationAuditEntry = {
  id: 'a1',
  at: '2026-09-30T12:00:00.000Z',
  actorUserId: 'user-mod',
  action: 'publication.hide',
  targetType: 'publication',
  targetId: ID,
  reason: 'Stolen',
};

const capabilities = signal({ publicExplore: true, admin: true });
const status = signal<AuthStatus>('authenticated');
const user = signal<{ id: string } | null>({ id: 'user-mod' });

let http: HttpTestingController;
let fixture: ComponentFixture<AdminPublicationsPage>;
let root: HTMLElement;

function mount(admin = true): void {
  capabilities.set({ publicExplore: true, admin });
  status.set('authenticated');
  user.set({ id: 'user-mod' });
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: I18n, useValue: { t: (key: string) => key, locale: signal('en') } },
      { provide: AuthService, useValue: { status, user } },
      { provide: ExploreAccess, useValue: { capabilities } },
    ],
  });
  http = TestBed.inject(HttpTestingController);
  fixture = TestBed.createComponent(AdminPublicationsPage);
  root = fixture.nativeElement as HTMLElement;
  fixture.detectChanges();
}

async function settle(): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1) {
    await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();
    await fixture.whenStable();
  }
}

/** Every request outstanding for `url` (query string aside), oldest first. */
const pendingFor = (url: string): TestRequest[] => http.match((request) => request.url === url);

async function answerList(items: AdminPublicationSummary[]): Promise<void> {
  const [request] = pendingFor(LIST);
  request.flush({ publications: items, nextCursor: null });
  await settle();
}

function button(label: string, scope: ParentNode = root): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.trim().endsWith(label),
  );
  if (!found) throw new Error(`no button "${label}"`);
  return found;
}

async function type(reason: string): Promise<void> {
  const field = root.querySelector('textarea') as HTMLTextAreaElement;
  field.value = reason;
  field.dispatchEvent(new Event('input'));
  await settle();
}

const submit = () => root.querySelector('form.action')?.dispatchEvent(new Event('submit'));

const fail = (request: TestRequest, code: number) =>
  request.flush({ error: { code: 'x', message: 'refused' } }, { status: code, statusText: 'x' });

afterEach(() => {
  http.verify();
  TestBed.resetTestingModule();
});

describe('AdminPublicationsPage', () => {
  it('fetches nothing for an account that does not moderate, and says so', async () => {
    mount(false);
    await settle();
    expect(root.textContent).toContain('admin.forbidden');
    expect(root.querySelector('.rows')).toBeNull();

    // Still resolving the session: not yet a refusal, and still no request.
    status.set('loading');
    await settle();
    expect(root.textContent).toContain('admin.loading');
  });

  it('lists every publication with what is wrong with it', async () => {
    mount();
    await answerList([
      publication({ moderatorHidden: true, openReports: 2 }),
      publication({ id: 'f'.repeat(20), title: 'Bloom', ownerVisible: false }),
    ]);
    const rows = [...root.querySelectorAll('.rows > li')].map((row) => row.textContent ?? '');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('admin.badgeHidden');
    expect(rows[0]).toContain('admin.openReports');
    expect(rows[0]).toContain('admin.restore');
    expect(rows[1]).toContain('admin.badgeUnpublished');
    expect(rows[1]).toContain('admin.hide');
  });

  it('hides only with a reason, once, and then shows what the server recorded', async () => {
    mount();
    await answerList([publication({ moderationRevision: 3 })]);

    button('admin.hide').click();
    await settle();
    expect(button('action.confirm').disabled).toBe(true);
    submit();
    expect(pendingFor(MODERATION)).toHaveLength(0);

    await type('Stolen');
    submit();
    // A second press while the first is in the air sends nothing more.
    await settle();
    expect(button('action.confirm').disabled).toBe(true);
    submit();
    const [request, ...extra] = pendingFor(MODERATION);
    expect(extra).toHaveLength(0);
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual({
      hidden: true,
      reason: 'Stolen',
      expectedModerationRevision: 3,
    });
    // Until the server answers, the row is exactly as it was.
    expect(root.textContent).not.toContain('admin.badgeHidden');

    request.flush({ publication: publication({ moderatorHidden: true, moderationRevision: 4 }) });
    await settle();
    await answerList([publication({ moderatorHidden: true, moderationRevision: 4 })]);
    expect(root.textContent).toContain('admin.badgeHidden');
    expect(root.querySelector('form.action')).toBeNull();
  });

  it('refreshes on a stale write and keeps the reason for a second, informed confirmation', async () => {
    mount();
    await answerList([publication()]);
    button('admin.hide').click();
    await settle();
    await type('Stolen');
    submit();
    fail(pendingFor(MODERATION)[0], 409);
    await settle();
    await answerList([publication({ moderationRevision: 2, openReports: 1 })]);

    expect(root.textContent).toContain('admin.conflict');
    expect((root.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Stolen');
    expect(root.textContent).toContain('admin.openReports');

    submit();
    expect(pendingFor(MODERATION)[0].request.body).toMatchObject({
      reason: 'Stolen',
      expectedModerationRevision: 2,
    });
  });

  it('reports a failed write without claiming anything changed', async () => {
    mount();
    await answerList([publication()]);
    button('admin.hide').click();
    await settle();
    await type('Stolen');
    submit();
    fail(pendingFor(MODERATION)[0], 500);
    await settle();

    expect(root.textContent).toContain('admin.error');
    expect(root.textContent).not.toContain('admin.badgeHidden');
    // Nothing was re-read, and the operator's reason is still there to retry with.
    expect(pendingFor(LIST)).toHaveLength(0);
    expect((root.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Stolen');
  });

  it('pages through reports and resolves one with its revision', async () => {
    mount();
    await answerList([publication()]);
    button('admin.reports').click();
    const [first] = pendingFor('/api/admin/reports');
    expect(first.request.params.get('status')).toBe('open');
    first.flush({ reports: [report('r1')], nextCursor: 'next' });
    await settle();

    button('explore.loadMore').click();
    const [more] = pendingFor('/api/admin/reports');
    expect(more.request.params.get('cursor')).toBe('next');
    more.flush({ reports: [report('r2', { revision: 1 })], nextCursor: null });
    await settle();
    expect(root.querySelectorAll('.rows > li')).toHaveLength(2);
    expect(root.textContent).toContain('admin.reporter');

    button('admin.resolve', root.querySelectorAll('.rows > li')[1]).click();
    await settle();
    await type('Checked');
    submit();
    const [resolution] = pendingFor('/api/admin/reports/r2/resolution');
    expect(resolution.request.body).toEqual({ reason: 'Checked', expectedRevision: 1 });
    resolution.flush({ report: report('r2', { status: 'resolved', revision: 2 }) });
    await settle();
    pendingFor('/api/admin/reports')[0].flush({ reports: [report('r1')], nextCursor: null });
    await settle();
    expect(root.querySelectorAll('.rows > li')).toHaveLength(1);
  });

  it('inspects a snapshot and restricts its publisher, spelling out the consequences', async () => {
    mount();
    await answerList([publication()]);
    button('admin.inspect').click();
    pendingFor(`${LIST}/${ID}`)[0].flush({
      publication: {
        ...publication(),
        attribution: '',
        derivedFrom: null,
        shader: {
          channels: [],
          project: { passes: [{ id: 'p1', name: 'Image', source: 'void main() {}' }] },
        },
      },
    });
    const [reports] = pendingFor('/api/admin/reports');
    expect(reports.request.params.get('publicationId')).toBe(ID);
    reports.flush({ reports: [report('r1')], nextCursor: null });
    const [history] = pendingFor('/api/admin/audit');
    expect(history.request.params.get('targetId')).toBe(ID);
    history.flush({ entries: [entry], nextCursor: null });
    await settle();
    pendingFor('/api/admin/publishers/user-alice/restriction')[0].flush({
      restriction: {
        userId: 'user-alice',
        restricted: false,
        revision: 0,
        reason: '',
        updatedAt: null,
      },
    });
    await settle();

    const panel = root.querySelector('.inspect') as HTMLElement;
    expect(panel.querySelector('pre')?.textContent).toBe('void main() {}');
    // Read, not run: inspecting never starts a renderer.
    expect(panel.querySelector('canvas')).toBeNull();
    expect(panel.textContent).toContain('Mine');
    expect(panel.textContent).toContain('Stolen');

    button('admin.restrict', panel).click();
    await settle();
    expect(root.querySelector('form.action')?.textContent).toContain('admin.restrictHint');
    await type('Abuse');
    submit();
    const [restrict] = pendingFor('/api/admin/publishers/user-alice/restriction');
    expect(restrict.request.method).toBe('PUT');
    expect(restrict.request.body).toEqual({
      restricted: true,
      reason: 'Abuse',
      expectedRevision: 0,
    });
    http
      .match(() => true)
      .forEach((request) => request.flush({}, { status: 500, statusText: 'x' }));
  });

  it('shows the recorded history', async () => {
    mount();
    await answerList([publication()]);
    button('admin.history').click();
    pendingFor('/api/admin/audit')[0].flush({ entries: [entry], nextCursor: null });
    await settle();
    const row = root.querySelector('.rows > li')?.textContent ?? '';
    expect(row).toContain('admin.entry');
    expect(row).toContain('Stolen');
    expect(row).toContain(ID);
  });

  it('drops everything the moment the session is no longer a moderator’s', async () => {
    mount();
    await answerList([publication()]);
    button('admin.hide').click();
    await settle();
    await type('Half typed');

    // Signed out, expired or switched: the capability goes first.
    capabilities.set({ publicExplore: true, admin: false });
    await settle();
    expect(root.textContent).not.toContain('Aurora');
    expect(root.textContent).not.toContain('Half typed');
    expect(root.textContent).toContain('admin.forbidden');

    // Another moderator on the same tab starts from the server, not from leftovers,
    // and nothing that was pending is sent on their behalf.
    user.set({ id: 'user-other-mod' });
    capabilities.set({ publicExplore: true, admin: true });
    await settle();
    expect(root.querySelector('form.action')).toBeNull();
    expect(pendingFor(MODERATION)).toHaveLength(0);
    await answerList([]);
    expect(root.textContent).toContain('admin.empty');
  });

  it('clears the page when the server itself refuses', async () => {
    mount();
    await answerList([publication()]);
    button('admin.refresh').click();
    fail(pendingFor(LIST)[0], 403);
    await settle();
    expect(root.textContent).not.toContain('Aurora');
    expect(root.textContent).toContain('admin.forbidden');
  });

  it('ignores an answer that arrives for the previous session', async () => {
    mount();
    const [stale] = pendingFor(LIST);
    capabilities.set({ publicExplore: true, admin: false });
    await settle();
    stale.flush({ publications: [publication()], nextCursor: null });
    await settle();
    expect(root.textContent).not.toContain('Aurora');
  });
});
