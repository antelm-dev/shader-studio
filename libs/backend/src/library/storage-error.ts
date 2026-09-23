import type { Result } from '@shader-studio/shared/validate';

/**
 * The one error type the storage layer speaks. Every repository translates its
 * engine's failures into one of these codes so callers (REST, IPC) never see a
 * driver error, a SQL string, a connection string or a stack trace.
 */
export class StorageError extends Error {
  constructor(
    readonly code: 'not_found' | 'conflict' | 'invalid' | 'io' | 'unauthorized',
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'StorageError';
  }

  get status(): number {
    switch (this.code) {
      // No session, or one that expired or was revoked. Distinct from 404,
      // which is what a shader belonging to someone else returns — the caller
      // is known there, just not entitled, and must not learn the difference.
      case 'unauthorized':
        return 401;
      case 'not_found':
        return 404;
      case 'conflict':
        return 409;
      case 'invalid':
        return 400;
      case 'io':
        return 500;
      default:
        return 500;
    }
  }
}

export function invalid(result: { errors: string[] }, message: string): never {
  throw new StorageError('invalid', message, result.errors);
}

export function expect<T>(result: Result<T>, message: string): T {
  if (!result.ok) invalid(result, message);
  return result.value;
}
