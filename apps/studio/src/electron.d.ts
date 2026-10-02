import type { bridge } from './contracts/desktop/ipc-bridge';

type ElectronApi = { bridge: typeof bridge };

declare global {
  interface Window {
    electron: ElectronApi;
  }
}

export {};
