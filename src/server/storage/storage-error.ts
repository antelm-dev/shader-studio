import type { Result } from '../../shared/validate';

export class StorageError extends Error {
  constructor(
    readonly code: 'not_found' | 'conflict' | 'invalid' | 'io',
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'StorageError';
  }

  get status(): number {
    switch (this.code) {
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
