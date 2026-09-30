import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  AdminPublicationDetail,
  AdminPublicationSummary,
  AdminReport,
  AdminReportPage,
  ModerationAuditPage,
  ModerationRequest,
  PublicationPage,
  PublicationStateFilter,
  PublisherRestriction,
  ReportStatusFilter,
  ResolveReportRequest,
  RestrictionRequest,
} from '@shadergrove/shared/publication';
import { API_BASE_URL } from '../api/api-base-url';
import { apiRequest } from '../api/shader-api';

type Params = Record<string, string>;

/** Drops the empty ones, so an unset filter is an absent parameter rather than `?search=`. */
function params(values: Record<string, string | null | undefined>): Params {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value)) as Params;
}

/**
 * The moderation endpoints under `/api/admin` — see `docs/public-explore-api.md`.
 *
 * Nothing here decides who may moderate: the server refuses every one of these
 * calls for an account that is not on its list, whatever this client believes.
 */
@Injectable({ providedIn: 'root' })
export class AdminApi {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  private get<T>(path: string, query: Params = {}): Promise<T> {
    const url = `${this.baseUrl}/api/admin${path}`;
    return apiRequest(firstValueFrom(this.http.get<T>(url, { params: query })));
  }

  private send<T>(method: 'PUT' | 'POST', path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}/api/admin${path}`;
    return apiRequest(firstValueFrom(this.http.request<T>(method, url, { body })));
  }

  publications(query: {
    state: PublicationStateFilter;
    search: string;
    cursor: string | null;
  }): Promise<PublicationPage<AdminPublicationSummary>> {
    return this.get('/publications', params(query));
  }

  async publication(id: string): Promise<AdminPublicationDetail> {
    return (await this.get<{ publication: AdminPublicationDetail }>(`/publications/${id}`))
      .publication;
  }

  async moderate(id: string, request: ModerationRequest): Promise<AdminPublicationSummary> {
    const path = `/publications/${id}/moderation`;
    return (await this.send<{ publication: AdminPublicationSummary }>('PUT', path, request))
      .publication;
  }

  reports(query: {
    status: ReportStatusFilter;
    publicationId?: string;
    cursor: string | null;
  }): Promise<AdminReportPage> {
    return this.get('/reports', params(query));
  }

  async resolve(id: string, request: ResolveReportRequest): Promise<AdminReport> {
    return (await this.send<{ report: AdminReport }>('POST', `/reports/${id}/resolution`, request))
      .report;
  }

  async restriction(userId: string): Promise<PublisherRestriction> {
    const path = `/publishers/${encodeURIComponent(userId)}/restriction`;
    return (await this.get<{ restriction: PublisherRestriction }>(path)).restriction;
  }

  async restrict(userId: string, request: RestrictionRequest): Promise<PublisherRestriction> {
    const path = `/publishers/${encodeURIComponent(userId)}/restriction`;
    return (await this.send<{ restriction: PublisherRestriction }>('PUT', path, request))
      .restriction;
  }

  audit(query: { targetId?: string; cursor: string | null }): Promise<ModerationAuditPage> {
    return this.get('/audit', params(query));
  }

  // For `<img>`: relative, and only ever answered for a moderator's own session.

  thumbnailUrl(publication: { id: string; revision: number }): string {
    return `/api/admin/publications/${publication.id}/thumbnail?v=${publication.revision}`;
  }

  textureUrl(publication: { id: string; revision: number }, channel: number): string {
    return `/api/admin/publications/${publication.id}/textures/${channel}?v=${publication.revision}`;
  }
}
