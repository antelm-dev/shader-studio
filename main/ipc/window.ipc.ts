import { BrowserWindow } from 'electron';
import { defineIpcEvents, defineIpcModule, handle, listen } from 'electron-ipc-module';

type WindowEvents = {
  'close-requested': [];
  'state-changed': [state: { maximized: boolean; fullscreen: boolean }];
};
export const windowEvents = defineIpcEvents<WindowEvents>();

export interface CloseController {
  approved: WeakSet<BrowserWindow>;
}

export function createWindowIpc(controller: CloseController) {
  return defineIpcModule('window', {
    minimize: listen((event) => BrowserWindow.fromWebContents(event.sender)?.minimize()),
    'toggle-maximize': listen((event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win?.isMaximized()) win.unmaximize(); else win?.maximize();
    }),
    'toggle-fullscreen': listen((event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win) win.setFullScreen(!win.isFullScreen());
    }),
    state: handle((event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      return { maximized: win?.isMaximized() ?? false, fullscreen: win?.isFullScreen() ?? false };
    }),
    close: listen((event) => BrowserWindow.fromWebContents(event.sender)?.close()),
    'approve-close': listen((event, approved: boolean) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || !approved) return;
      controller.approved.add(win);
      win.close();
    }),
  });
}
