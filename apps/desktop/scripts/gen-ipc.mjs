import ipcBridge from 'electron-ipc-module/rollup-plugin';

import { createLogger } from '../../../scripts/_lib/logger.mjs';

const log = createLogger('gen:ipc');
const outFile = '../../packages/desktop-api/src/ipc-bridge.ts';

const plugin = ipcBridge({
  ipcDir: './main/src/ipc',
  outFile,
  tsconfig: './tsconfig.main.json',
});

await plugin.buildStart();
log.info(`Wrote ${outFile}`);
