import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createLogger } from '../../../scripts/_lib/logger.mjs';

const log = createLogger('clean');
const root = resolve(import.meta.dirname, '../../..');
const paths = ['dist-main', 'dist-renderer', 'release'].map((path) => resolve(root, path));

await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
log.info('Removed dist-main, dist-renderer, release');
