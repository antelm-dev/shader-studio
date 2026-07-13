import type { OutputOptions, Plugin } from 'rollup';
import { createElectronRunner } from './core.js';
import type { ElectronRunOptions } from './types.js';

export type { ElectronRunOptions } from './types.js';

/**
 * Rollup plugin that (re)launches Electron on every bundle write and shuts the
 * process down when the watcher closes.
 */
export default function electronRun(options?: ElectronRunOptions): Plugin {
  const runner = createElectronRunner(options);

  return {
    name: 'electron-run',
    writeBundle(output: OutputOptions) {
      runner.scheduleRestart(output, 'rebuild');
    },
    async closeWatcher() {
      await runner.close();
    },
  };
}
