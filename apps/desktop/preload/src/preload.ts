import { contextBridge } from 'electron';

import { bridge } from '@shader-studio/desktop-api';

const api = { bridge };
export type ElectronApi = typeof api;

contextBridge.exposeInMainWorld('electron', api);
