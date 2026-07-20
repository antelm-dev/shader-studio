import { defineIpcEvents, defineIpcModule, handle, listen } from 'electron-ipc-module';

import type { UpdateController } from '../core/updater';

export type UpdateStatus =
  | 'unavailable'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  availableVersion?: string;
  progress?: number;
  message?: string;
}

type UpdateEvents = { 'update-state-changed': [state: UpdateState] };
export const updateEvents = defineIpcEvents<UpdateEvents>();

export function createUpdateIpc(controller: UpdateController) {
  return defineIpcModule('update', {
    state: handle(() => controller.current()),
    check: handle(() => controller.check()),
    install: listen(() => void controller.update()),
  });
}
