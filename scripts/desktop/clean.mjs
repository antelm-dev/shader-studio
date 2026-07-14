import { rm } from 'node:fs/promises';

import { createLogger } from '../_lib/logger.mjs';

const log = createLogger('clean');
const paths = ['dist-main', 'dist-renderer', 'release'];

await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
log.info(`Removed ${paths.join(', ')}`);
