/**
 * Logging for the Nest API. Nest's own `Logger` does the formatting and
 * context tagging, so all this adds is the `LOG_LEVEL` env switch and a
 * per-request access log.
 *
 * `libs/backend` deliberately keeps using plain `console` — it is also loaded
 * by the Electron main process, which has no Nest runtime.
 */

import { Injectable, Logger, type LogLevel, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/** Loudest first, so a level enables itself and everything above it. */
const LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'];
const DEFAULT_LEVEL: LogLevel = 'log';

/** `LOG_LEVEL` names the noisiest level to keep; an unknown name falls back to `log`. */
export function logLevels(name = process.env['LOG_LEVEL']): LogLevel[] {
  const index = LEVELS.indexOf((name ?? DEFAULT_LEVEL) as LogLevel);
  return LEVELS.slice(0, (index === -1 ? LEVELS.indexOf(DEFAULT_LEVEL) : index) + 1);
}

@Injectable()
export class RequestLogger implements NestMiddleware {
  private readonly logger = new Logger('api');

  use(request: Request, response: Response, next: NextFunction): void {
    const started = Date.now();
    response.on('finish', () => {
      const line = `${request.method} ${request.originalUrl} ${response.statusCode} ${Date.now() - started}ms`;
      if (response.statusCode >= 500) this.logger.error(line);
      else if (response.statusCode >= 400) this.logger.warn(line);
      else this.logger.log(line);
    });
    next();
  }
}
