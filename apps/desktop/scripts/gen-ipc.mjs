import { runIpcBridgeGeneration } from 'electron-ipc-module/generator';

import { createLogger } from './_lib/logger.mjs';

const log = createLogger('gen:ipc');

const result = runIpcBridgeGeneration({
  ipcDir: './main/src/ipc',
  outFile: '../../libs/desktop-api/src/ipc-bridge.ts',
  tsconfig: './tsconfig.main.json',
});

log.info(`Wrote ${result.outFile}`);
