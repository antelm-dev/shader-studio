import ipcBridge from 'electron-ipc-module/rollup-plugin';

const plugin = ipcBridge({
  ipcDir: './main/ipc',
  outFile: './main/generated/ipc-bridge.ts',
  tsconfig: './tsconfig.main.json',
});

await plugin.buildStart();
