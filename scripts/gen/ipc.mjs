import ipcBridge from 'electron-ipc-module/rollup-plugin';

import { createLogger } from '../_lib/logger.mjs';

const log = createLogger('gen:ipc');
const outFile = './apps/desktop/generated/ipc-bridge.ts';

const plugin = ipcBridge({
  ipcDir: './apps/desktop/main/src/ipc',
  outFile,
  tsconfig: './tsconfig.main.json',
});

await plugin.buildStart();
log.info(`Wrote ${outFile}`);
