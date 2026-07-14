import { rm } from 'node:fs/promises';

await Promise.all(
  ['dist-main', 'dist-renderer', 'release'].map((path) =>
    rm(path, { recursive: true, force: true }),
  ),
);
