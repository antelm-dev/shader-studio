import { BrowserWindow } from 'electron';
import { defineIpcEvents, defineIpcModule, handle } from 'electron-ipc-module';

import { StorageError } from '@shader-studio/backend/library';
import type { SyncChangedEvent, SyncRemoveRequest } from '@shader-studio/desktop-api/contracts';
import type { SyncService } from '../sync/sync-service';

type SyncEvents = { 'sync-changed': [event: SyncChangedEvent] };
export const syncEvents = defineIpcEvents<SyncEvents>();

export function broadcastSync(event: SyncChangedEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('sync-changed', event);
  }
}

function idsArg(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((id) => typeof id === 'string')) {
    throw new StorageError('invalid', 'ids must be an array of strings');
  }
  return value;
}

function removeArg(value: unknown): SyncRemoveRequest {
  const { id, mode, userId, revision } = (value ?? {}) as Partial<SyncRemoveRequest>;
  if (
    typeof id !== 'string' ||
    (mode !== 'local' && mode !== 'everywhere') ||
    typeof userId !== 'string' ||
    !Number.isInteger(revision)
  ) {
    throw new StorageError('invalid', 'remove takes { id, mode, userId, revision }');
  }
  return { id, mode, userId, revision: revision! };
}

export function createSyncIpc(sync: SyncService) {
  return defineIpcModule('sync', {
    statuses: handle(() => sync.snapshot()),
    upload: handle((_event, ids: string[]) => sync.upload(idsArg(ids))),
    'upload-all': handle(() => sync.uploadAll()),
    run: handle(() => sync.run()),
    remove: handle((_event, request: SyncRemoveRequest) => sync.remove(removeArg(request))),
  });
}
