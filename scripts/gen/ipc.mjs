import ipcBridge from 'electron-ipc-module/rollup-plugin';

import { createLogger } from '../_lib/logger.mjs';

const log = createLogger('gen:ipc');
const outFile = './main/generated/ipc-bridge.ts';

const plugin = ipcBridge({
  ipcDir: './main/ipc',
  outFile,
  tsconfig: './tsconfig.main.json',
});

await plugin.buildStart();
log.info(`Wrote ${outFile}`);
