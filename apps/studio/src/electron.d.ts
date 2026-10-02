import type { bridge } from '@shadergrove/desktop-api';

type ElectronApi = { bridge: typeof bridge };

declare global {
  interface Window {
    electron: ElectronApi;
  }
}

export {};
