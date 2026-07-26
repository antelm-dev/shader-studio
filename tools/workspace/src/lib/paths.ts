import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const root = resolve(here, '../../../..');
export const script = (...parts: string[]): string =>
  resolve(root, 'tools/workspace/src', ...parts);
