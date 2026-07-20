import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  ApiErrorBody,
  Bundle,
  ImportMode,
  ImportResult,
  Preset,
  RenderSettings,
  ShaderParams,
  ShaderRecord,
  ShaderSummary,
} from '@shader-studio/shared/model';
import type { UpdateShaderPatch } from '@shader-studio/shared/api';
import { mimeFromExt } from '@shader-studio/shared/validate';
import { API_BASE_URL } from './api-base-url';

/** The bytes and decoded dimensions of an image about to be assigned to a channel. */
export interface TextureUpload {
  ext: string;
  bytes: Uint8Array;
  width: number;
  height: number;
}

/** An encoded preview frame on its way to disk. Its size is fixed by the encoder. */
export interface ThumbnailUpload {
  ext: string;
  bytes: Uint8Array;
}

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

export type { UpdateShaderPatch } from '@shader-studio/shared/api';

export abstract class ShaderApi {
  abstract list(): Promise<ShaderSummary[]>;
  abstract read(id: string): Promise<ShaderRecord>;
  abstract create(name: string, description?: string): Promise<ShaderRecord>;
  abstract update(id: string, patch: UpdateShaderPatch): Promise<ShaderRecord>;
  abstract duplicate(id: string, name?: string): Promise<ShaderRecord>;
  abstract remove(id: string): Promise<void>;
  /** Omitting `render` saves a values-only preset, which leaves bloom alone when applied. */
  abstract savePreset(
    id: string,
    name: string,
    values: ShaderParams,
    render?: RenderSettings,
  ): Promise<Preset>;
  abstract deletePreset(id: string, presetId: string): Promise<void>;
  abstract exportShader(id: string): Promise<Bundle>;
  abstract exportAll(): Promise<Bundle>;
  abstract importBundle(bundle: unknown, mode: ImportMode): Promise<ImportResult>;
  abstract setTexture(id: string, channel: number, upload: TextureUpload): Promise<ShaderRecord>;
  abstract clearTexture(id: string, channel: number): Promise<ShaderRecord>;
  abstract setThumbnail(id: string, upload: ThumbnailUpload): Promise<ShaderRecord>;
  /** Fetches a shader from Shadertoy and returns it as an importable bundle. */
  abstract importShadertoy(
    idOrUrl: string,
    apiKey: string,
  ): Promise<{ bundle: Bundle; warnings: string[] }>;
}

@Injectable()
export class HttpShaderApi extends ShaderApi {
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

  override async list(): Promise<ShaderSummary[]> {
    const response = await this.get<{ shaders: ShaderSummary[] }>('/shaders');
    return response.shaders;
  }

  override async read(id: string): Promise<ShaderRecord> {
    const response = await this.get<{ shader: ShaderRecord }>(`/shaders/${id}`);
    return response.shader;
  }

  override async create(name: string, description = ''): Promise<ShaderRecord> {
    const response = await this.post<{ shader: ShaderRecord }>('/shaders', { name, description });
    return response.shader;
  }

  override async update(id: string, patch: UpdateShaderPatch): Promise<ShaderRecord> {
    const response = await this.put<{ shader: ShaderRecord }>(`/shaders/${id}`, patch);
    return response.shader;
  }

  override async duplicate(id: string, name?: string): Promise<ShaderRecord> {
    const response = await this.post<{ shader: ShaderRecord }>(
      `/shaders/${id}/duplicate`,
      name ? { name } : {},
    );
    return response.shader;
  }

  override remove(id: string): Promise<void> {
    return this.delete(`/shaders/${id}`);
  }

  // --- Presets ------------------------------------------------------------

  override async savePreset(
    id: string,
    name: string,
    values: ShaderParams,
    render?: RenderSettings,
  ): Promise<Preset> {
    const response = await this.post<{ preset: Preset }>(`/shaders/${id}/presets`, {
      name,
      values,
      ...(render ? { render } : {}),
    });
    return response.preset;
  }

  override deletePreset(id: string, presetId: string): Promise<void> {
    return this.delete(`/shaders/${id}/presets/${presetId}`);
  }

  // --- Import / export ----------------------------------------------------

  override exportShader(id: string): Promise<Bundle> {
    return this.get<Bundle>(`/shaders/${id}/export`);
  }

  override exportAll(): Promise<Bundle> {
    return this.get<Bundle>('/export');
  }

  override importBundle(bundle: unknown, mode: ImportMode): Promise<ImportResult> {
    return this.post<ImportResult>('/import', { bundle, mode });
  }

  override importShadertoy(
    idOrUrl: string,
    apiKey: string,
  ): Promise<{ bundle: Bundle; warnings: string[] }> {
    return this.post<{ bundle: Bundle; warnings: string[] }>('/import/shadertoy', {
      idOrUrl,
      apiKey,
    });
  }

  // --- Textures -------------------------------------------------------------

  override async setTexture(
    id: string,
    channel: number,
    upload: TextureUpload,
  ): Promise<ShaderRecord> {
    const blob = new Blob([upload.bytes.slice()], { type: mimeFromExt(upload.ext) });
    const query = `?width=${upload.width}&height=${upload.height}`;
    const response = await this.request(
      firstValueFrom(
        this.http.put<{ shader: ShaderRecord }>(
          this.url(`/shaders/${id}/textures/${channel}${query}`),
          blob,
        ),
      ),
    );
    return response.shader;
  }

  override async clearTexture(id: string, channel: number): Promise<ShaderRecord> {
    const response = await this.request(
      firstValueFrom(
        this.http.delete<{ shader: ShaderRecord }>(this.url(`/shaders/${id}/textures/${channel}`)),
      ),
    );
    return response.shader;
  }

  // --- Thumbnail ------------------------------------------------------------

  override async setThumbnail(id: string, upload: ThumbnailUpload): Promise<ShaderRecord> {
    const blob = new Blob([upload.bytes.slice()], { type: mimeFromExt(upload.ext) });
    const response = await this.request(
      firstValueFrom(
        this.http.put<{ shader: ShaderRecord }>(this.url(`/shaders/${id}/thumbnail`), blob),
      ),
    );
    return response.shader;
  }
}
