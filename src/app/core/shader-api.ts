import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  ApiErrorBody,
  Bundle,
  ImportMode,
  ImportResult,
  Preset,
  ShaderParams,
  ShaderRecord,
  ShaderSummary,
} from '../../shared/model';
import { API_BASE_URL } from './api-base-url';

/** A failed API call, carrying the server's own message and field details. */
export class ApiError extends Error {
  constructor(
    override readonly message: string,
    readonly details: string[] = [],
    readonly status = 0,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** One string suitable for a snackbar. */
  get summary(): string {
    return this.details.length ? `${this.message}: ${this.details[0]}` : this.message;
  }
}

export interface UpdateShaderPatch {
  name?: string;
  description?: string;
  controls?: unknown;
  render?: unknown;
  fragment?: string;
  vertex?: string;
}

@Injectable({ providedIn: 'root' })
export class ShaderApi {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  private url(path: string): string {
    return `${this.baseUrl}/api${path}`;
  }

  /** Normalise every transport/HTTP failure into an `ApiError`. */
  private async request<T>(source: Promise<T>): Promise<T> {
    try {
      return await source;
    } catch (error) {
      if (error instanceof HttpErrorResponse) {
        const body = error.error as ApiErrorBody | string | null;
        if (body && typeof body === 'object' && 'error' in body) {
          throw new ApiError(body.error.message, body.error.details ?? [], error.status);
        }
        throw new ApiError(
          error.status === 0 ? 'Cannot reach the server' : `Request failed (${error.status})`,
          [],
          error.status,
        );
      }
      throw new ApiError(String(error));
    }
  }

  private get<T>(path: string): Promise<T> {
    return this.request(firstValueFrom(this.http.get<T>(this.url(path))));
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request(firstValueFrom(this.http.post<T>(this.url(path), body)));
  }

  private put<T>(path: string, body: unknown): Promise<T> {
    return this.request(firstValueFrom(this.http.put<T>(this.url(path), body)));
  }

  private delete(path: string): Promise<void> {
    return this.request(
      firstValueFrom(this.http.delete<void>(this.url(path))).then(() => undefined),
    );
  }

  // --- Shaders ------------------------------------------------------------

  async list(): Promise<ShaderSummary[]> {
    const response = await this.get<{ shaders: ShaderSummary[] }>('/shaders');
    return response.shaders;
  }

  async read(id: string): Promise<ShaderRecord> {
    const response = await this.get<{ shader: ShaderRecord }>(`/shaders/${id}`);
    return response.shader;
  }

  async create(name: string, description = ''): Promise<ShaderRecord> {
    const response = await this.post<{ shader: ShaderRecord }>('/shaders', { name, description });
    return response.shader;
  }

  async update(id: string, patch: UpdateShaderPatch): Promise<ShaderRecord> {
    const response = await this.put<{ shader: ShaderRecord }>(`/shaders/${id}`, patch);
    return response.shader;
  }

  async duplicate(id: string, name?: string): Promise<ShaderRecord> {
    const response = await this.post<{ shader: ShaderRecord }>(
      `/shaders/${id}/duplicate`,
      name ? { name } : {},
    );
    return response.shader;
  }

  remove(id: string): Promise<void> {
    return this.delete(`/shaders/${id}`);
  }

  // --- Presets ------------------------------------------------------------

  async savePreset(id: string, name: string, values: ShaderParams): Promise<Preset> {
    const response = await this.post<{ preset: Preset }>(`/shaders/${id}/presets`, {
      name,
      values,
    });
    return response.preset;
  }

  deletePreset(id: string, presetId: string): Promise<void> {
    return this.delete(`/shaders/${id}/presets/${presetId}`);
  }

  // --- Import / export ----------------------------------------------------

  exportShader(id: string): Promise<Bundle> {
    return this.get<Bundle>(`/shaders/${id}/export`);
  }

  exportAll(): Promise<Bundle> {
    return this.get<Bundle>('/export');
  }

  importBundle(bundle: unknown, mode: ImportMode): Promise<ImportResult> {
    return this.post<ImportResult>('/import', { bundle, mode });
  }
}
