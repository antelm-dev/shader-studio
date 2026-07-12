import type { NextFunction, Request, Response } from 'express';

export const BODY_LIMIT = '8mb';

export function attachmentName(name: string): string {
  const ascii = name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'shaders';
  return `${ascii}.shader.json`;
}

export function route(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };
}

export function param(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[] | undefined>)[name];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}
