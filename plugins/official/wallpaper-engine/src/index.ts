/**
 * Wallpaper Engine Export — the Worker side.
 *
 * Gets a snapshot of the open draft (texture metadata only, never bytes) and
 * returns `wallpaper-web/v1` data. It writes no files and supplies no HTML or
 * script: the host's runtime builds the wallpaper from this data.
 */
import type { ProjectExportInput } from '@shadergrove/shared/plugin';

import { mapWallpaper } from './map';

shaderStudio.handle('projectExporter:wallpaper-engine', (params) =>
  mapWallpaper(params as ProjectExportInput),
);
