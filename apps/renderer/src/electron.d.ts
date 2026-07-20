import type { ElectronApi } from '../../desktop/preload/src/preload';

declare global {
  interface Window {
    electron: ElectronApi;
  }
}

export {};
