import { contextBridge } from 'electron';

import { bridge } from './generated/ipc-bridge';

const api = { bridge };
export type ElectronApi = typeof api;

contextBridge.exposeInMainWorld('electron', api);
