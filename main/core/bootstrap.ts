import { app, dialog, protocol } from 'electron';

import type { createCustomScheme } from './electron';

type Protocol = ReturnType<typeof createCustomScheme>;

export interface PrepareOptions {
  protocols?: { scheme: Protocol; handler: (request: Request) => Response | Promise<Response> }[];
  onReady: () => void | Promise<void>;
  onBeforeQuit?: () => void | Promise<void>;
}

export function prepare(options: PrepareOptions): void {
  const protocols = options.protocols ?? [];
  protocol.registerSchemesAsPrivileged(protocols.map(({ scheme }) => scheme.scheme));

  app.whenReady().then(async () => {
    try {
      for (const entry of protocols) entry.scheme.registerHandler(entry.handler);
      await options.onReady();
    } catch (error) {
      dialog.showErrorBox('Shader Studio could not start', error instanceof Error ? error.message : String(error));
      app.exit(1);
    }
  });

  app.on('before-quit', () => void options.onBeforeQuit?.());
}
