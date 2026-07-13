import { app, BrowserWindow, Menu, screen, shell } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { createIpcContainer } from 'electron-ipc-module';

import { ShaderStorage } from '../src/server/storage';
import { prepare } from './core/bootstrap';
import { createCustomScheme } from './core/electron';
import { UpdateController } from './core/updater';
import { env } from './env';
import { createFilesIpc } from './ipc/files.ipc';
import { createI18nIpc } from './ipc/i18n.ipc';
import { createMigrationIpc } from './ipc/migration.ipc';
import { createShaderIpc } from './ipc/shader.ipc';
import { createUpdateIpc } from './ipc/update.ipc';
import { createWindowIpc, type CloseController } from './ipc/window.ipc';

const scheme = createCustomScheme(env.scheme, {
  standard: true,
  secure: true,
  supportFetchAPI: true,
});
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};
const CLIENT_DIR = resolve(env.paths.clientDir);

async function serveClient(request: Request): Promise<Response> {
  let requested: string;
  try {
    requested = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, ''));
  } catch {
    return new Response('Bad request', { status: 400 });
  }
  requested ||= 'index.html';
  let file = resolve(CLIENT_DIR, requested);
  const rel = relative(CLIENT_DIR, file);
  if (rel.startsWith('..') || isAbsolute(rel)) return new Response('Forbidden', { status: 403 });
  try {
    const data = await readFile(file);
    return new Response(data, {
      headers: { 'content-type': MIME_TYPES[extname(file)] ?? 'application/octet-stream' },
    });
  } catch {
    if (extname(requested)) return new Response('Not found', { status: 404 });
    file = join(CLIENT_DIR, 'index.html');
    return new Response(await readFile(file), { headers: { 'content-type': 'text/html' } });
  }
}

interface WindowState {
  bounds?: Electron.Rectangle;
  maximized?: boolean;
}

function validBounds(value: unknown): Electron.Rectangle | undefined {
  const item = value as Partial<Electron.Rectangle> | null;
  if (
    !item ||
    !['x', 'y', 'width', 'height'].every((key) =>
      Number.isFinite(item[key as keyof Electron.Rectangle]),
    )
  )
    return undefined;
  if ((item.width ?? 0) < 800 || (item.height ?? 0) < 600) return undefined;
  const bounds = item as Electron.Rectangle;
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      bounds.x < area.x + area.width &&
      bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + bounds.height > area.y
    );
  })
    ? bounds
    : undefined;
}

async function readWindowState(path: string): Promise<WindowState> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as WindowState;
  } catch {
    return {};
  }
}

let outputWindow: BrowserWindow | null = null;
const closeController: CloseController = {
  approved: new WeakSet(),
  openOutput: () => undefined,
  closeOutput: () => outputWindow?.close(),
  outputOpen: () => outputWindow !== null,
};
let mainWindow: BrowserWindow | null = null;

if (!app.requestSingleInstanceLock()) app.quit();
else
  app.on('second-instance', () => {
    mainWindow?.restore();
    mainWindow?.focus();
  });

prepare({
  protocols: env.production ? [{ scheme, handler: serveClient }] : [],
  onReady: async () => {
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    const userData = app.getPath('userData');
    const statePath = join(userData, 'window-state.json');
    const migrationPath = join(userData, 'migration.json');
    const saved = await readWindowState(statePath);
    const bounds = validBounds(saved.bounds);
    const examplesDir = env.production
      ? join(process.resourcesPath, 'examples')
      : resolve('examples');
    const i18nDir = env.production ? join(process.resourcesPath, 'i18n') : resolve('i18n');
    const storage = new ShaderStorage({ dataDir: join(userData, 'library'), examplesDir });
    await storage.init();

    const ipc = createIpcContainer();
    const updates = new UpdateController(() => {
      for (const window of BrowserWindow.getAllWindows()) closeController.approved.add(window);
    });
    await ipc.loadAll({
      shader: createShaderIpc(storage),
      files: createFilesIpc(),
      i18n: createI18nIpc(i18nDir),
      migration: createMigrationIpc(storage, migrationPath),
      window: createWindowIpc(closeController),
      update: createUpdateIpc(updates),
    });

    const win = new BrowserWindow({
      width: bounds?.width ?? 1440,
      height: bounds?.height ?? 900,
      x: bounds?.x,
      y: bounds?.y,
      minWidth: 800,
      minHeight: 600,
      show: false,
      frame: false,
      backgroundColor: '#090b10',
      webPreferences: {
        preload: env.paths.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    mainWindow = win;
    closeController.openOutput = () => {
      if (outputWindow) {
        outputWindow.show();
        outputWindow.focus();
        return;
      }

      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const output = new BrowserWindow({
        width: Math.min(1280, display.workArea.width),
        height: Math.min(720, display.workArea.height),
        x: display.workArea.x + Math.max(0, Math.round((display.workArea.width - 1280) / 2)),
        y: display.workArea.y + Math.max(0, Math.round((display.workArea.height - 720) / 2)),
        minWidth: 480,
        minHeight: 270,
        show: false,
        autoHideMenuBar: true,
        backgroundColor: '#090b10',
        webPreferences: {
          preload: env.paths.preload,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      outputWindow = output;
      output.once('ready-to-show', () => output.show());
      output.on('closed', () => {
        outputWindow = null;
        win.webContents.send('output-state-changed', false);
      });
      output.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      output.webContents.on('will-navigate', (event, url) => {
        const allowed = env.production
          ? url.startsWith(`${env.scheme}://`)
          : url.startsWith(env.devServerUrl);
        if (!allowed) event.preventDefault();
      });
      const outputUrl = env.production
        ? new URL('/output', env.urls.renderer).toString()
        : new URL('/output', env.devServerUrl).toString();
      void output.loadURL(outputUrl);
      win.webContents.send('output-state-changed', true);
    };
    if (saved.maximized) win.maximize();
    win.once('ready-to-show', () => win.show());
    win.on('close', (event) => {
      if (closeController.approved.has(win)) return;
      event.preventDefault();
      win.webContents.send('close-requested');
    });
    win.on('closed', () => {
      outputWindow?.close();
      mainWindow = null;
    });
    const pushWindowState = () => {
      win.webContents.send('state-changed', {
        maximized: win.isMaximized(),
        fullscreen: win.isFullScreen(),
      });
    };
    const saveState = () =>
      void writeFile(
        statePath,
        JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() }),
        'utf8',
      );
    win.on('resize', saveState);
    win.on('move', saveState);
    win.on('maximize', () => {
      saveState();
      pushWindowState();
    });
    win.on('unmaximize', () => {
      saveState();
      pushWindowState();
    });
    win.on('enter-full-screen', pushWindowState);
    win.on('leave-full-screen', pushWindowState);
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => {
      const allowed = env.production
        ? url.startsWith(`${env.scheme}://`)
        : url.startsWith(env.devServerUrl);
      if (!allowed) event.preventDefault();
    });
    if (env.production) await win.loadURL(env.urls.renderer);
    else {
      const load = () => void win.loadURL(env.devServerUrl);
      win.webContents.on('did-fail-load', () => setTimeout(load, 300));
      load();
    }
    void updates.check();
  },
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
