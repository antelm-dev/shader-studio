import { randomUUID } from 'node:crypto';

import { WebSocket, WebSocketServer } from 'ws';

import type {
  AppResponse,
  ControllerCommand,
  ControllerCommandType,
  ControllerRequest,
  ControllerResultMap,
} from '@shader-studio/shared/mcp-protocol';

export const NO_APP =
  'Aucun onglet Shader Studio connecté — lance `pnpm dev` et garde une page ouverte';

export const DEFAULT_TIMEOUT_MS = 8_000;
export const SCREENSHOT_TIMEOUT_MS = 15_000;

const BIND_RETRIES = 20;
const BIND_RETRY_MS = 250;

let appSocket: WebSocket | null = null;
let activeBridge: WebSocketServer | null = null;

const pending = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

function messageText(data: WebSocket.RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function isAddrInUse(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
  );
}

function rejectPending(reason: string): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
  pending.clear();
}

function handleAppMessage(raw: string): void {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  if (typeof message !== 'object' || message === null || !('id' in message) || !('ok' in message)) {
    return;
  }

  const response = message as AppResponse;
  const entry = pending.get(response.id);
  if (!entry) return;

  clearTimeout(entry.timer);
  pending.delete(response.id);

  if (response.ok) entry.resolve(response.result);
  else entry.reject(new Error(response.error));
}

function wireBridge(wss: WebSocketServer, port: number): void {
  wss.on('connection', (socket) => {
    appSocket = socket;

    socket.on('message', (data) => handleAppMessage(messageText(data)));
    socket.on('close', () => {
      if (appSocket === socket) appSocket = null;
    });
  });

  wss.on('listening', () => {
    console.error(`[shader-studio-mcp] WebSocket bridge listening on ws://127.0.0.1:${port}`);
  });
}

function listenOnce(port: number): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port });

    const onError = (error: Error) => {
      wss.close();
      reject(error);
    };

    wss.once('listening', () => {
      wss.off('error', onError);
      resolve(wss);
    });

    wss.once('error', onError);
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startBridge(port: number): Promise<WebSocketServer> {
  if (activeBridge) return activeBridge;

  for (let attempt = 0; attempt <= BIND_RETRIES; attempt++) {
    try {
      const wss = await listenOnce(port);
      wireBridge(wss, port);
      activeBridge = wss;
      return wss;
    } catch (error) {
      if (!isAddrInUse(error) || attempt === BIND_RETRIES) throw error;
      await wait(BIND_RETRY_MS);
    }
  }

  throw new Error(`Could not bind ws://127.0.0.1:${port}`);
}

export function installBridgeShutdown(wss: WebSocketServer): void {
  const shutdown = () => {
    rejectPending('Bridge shutting down');
    appSocket = null;
    activeBridge = null;
    wss.close();
    process.exit(0);
  };

  process.stdin.on('end', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export async function closeBridge(wss: WebSocketServer): Promise<void> {
  rejectPending('Bridge closed');
  appSocket = null;
  if (activeBridge === wss) activeBridge = null;

  await new Promise<void>((resolve, reject) => {
    wss.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function callApp<T extends ControllerCommandType>(
  command: Extract<ControllerCommand, { type: T }>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ControllerResultMap[T]> {
  if (!appSocket || appSocket.readyState !== WebSocket.OPEN) {
    throw new Error(NO_APP);
  }

  const id = randomUUID();
  const request = { id, ...command } as ControllerRequest;

  return new Promise<ControllerResultMap[T]>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout waiting for "${command.type}"`));
    }, timeoutMs);

    pending.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timer,
    });

    appSocket!.send(JSON.stringify(request));
  });
}

export function resetBridgeForTests(): void {
  appSocket = null;
  activeBridge = null;
  rejectPending('Bridge reset');
}
