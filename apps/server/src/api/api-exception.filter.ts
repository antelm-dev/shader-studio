import { ArgumentsHost, Catch, HttpException, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';

import { StorageError } from '@shader-studio/backend/library';
import type { ApiErrorBody } from '@shader-studio/shared/model';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (response.headersSent) return;

    if (error instanceof StorageError) {
      const body: ApiErrorBody = {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details.length ? { details: error.details } : {}),
        },
      };
      response.status(error.status).json(body);
      return;
    }

    if (error instanceof SyntaxError && 'body' in error) {
      const body: ApiErrorBody = {
        error: { code: 'invalid', message: 'Request body is not valid JSON' },
      };
      response.status(400).json(body);
      return;
    }

    if (error instanceof HttpException && error.getStatus() === 400) {
      const body: ApiErrorBody = {
        error: { code: 'invalid', message: 'Request body is not valid JSON' },
      };
      response.status(400).json(body);
      return;
    }

    if (error instanceof HttpException && error.getStatus() === 404) {
      const body: ApiErrorBody = {
        error: { code: 'not_found', message: 'No such API route' },
      };
      response.status(404).json(body);
      return;
    }

    console.error('[api] unhandled error', error);
    const body: ApiErrorBody = {
      error: { code: 'internal', message: 'Internal server error' },
    };
    response.status(500).json(body);
  }
}
