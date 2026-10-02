import type { bridge } from './desktop/contracts/ipc-bridge';

type ElectronApi = { bridge: typeof bridge };

declare global {
  interface Window {
    electron: ElectronApi;
  }
}

export {};
