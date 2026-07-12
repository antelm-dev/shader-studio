import type { ElectronApi } from '../main/preload';

declare global {
  interface Window {
    electron: ElectronApi;
  }
}

export {};
