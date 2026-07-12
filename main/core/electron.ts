import { protocol } from 'electron';

export function createCustomScheme(name: string, privileges: Electron.Privileges = {}) {
  return {
    scheme: { scheme: name, privileges } as Electron.CustomScheme,
    unregisterHandler: () => protocol.unhandle(name),
    registerHandler: (handler: Parameters<typeof protocol.handle>[1]) => protocol.handle(name, handler),
  };
}
