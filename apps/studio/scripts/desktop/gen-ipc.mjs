import { runIpcBridgeGeneration } from 'electron-ipc-module/generator';

import { createLogger } from './_lib/logger.mjs';

const log = createLogger('gen:ipc');

const result = runIpcBridgeGeneration({
  ipcDir: './src/desktop/main/ipc',
  outFile: '../../libs/desktop-api/src/ipc-bridge.ts',
  tsconfig: './tsconfig.desktop.main.json',
});

log.info(`Wrote ${result.outFile}`);
