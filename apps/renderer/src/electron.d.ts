import type { bridge } from '@shader-studio/desktop-api';

type ElectronApi = { bridge: typeof bridge };

declare global {
  interface Window {
    electron: ElectronApi;
  }
}

export {};
