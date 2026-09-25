import { BrowserWindow } from 'electron';
import { defineIpcEvents, defineIpcModule, handle, listen } from 'electron-ipc-module';

import type { AccountState } from '@shader-studio/desktop-api/contracts';
import type { DesktopAccountSession } from '../account/account-session';

type AccountEvents = { 'account-changed': [state: AccountState] };
export const accountEvents = defineIpcEvents<AccountEvents>();

/** The renderer sees the account's state and nothing else: never the token. */
export function createAccountIpc(account: DesktopAccountSession) {
  account.onChange((state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('account-changed', state);
    }
  });
  return defineIpcModule('account', {
    state: handle(() => account.state()),
    'sign-in': handle(() => account.signIn()),
    'sign-out': handle(() => account.signOut()),
    'open-account-page': listen(() => account.openAccountPage()),
  });
}
