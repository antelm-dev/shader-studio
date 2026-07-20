import { randomUUID } from 'node:crypto';

import { WebSocket, WebSocketServer } from 'ws';

import {
  AppResponseEnvelopeSchema,
  COMMAND_SCHEMAS,
  ControllerRequestSchema,
  HandshakeSchema,
  MCP_BRIDGE_PROTOCOL_VERSION,
  MCP_LIMITS,
  mcpError,
  type ControllerCommand,
  type ControllerCommandType,
  type ControllerResultMap,
  type Handshake,
  type HandshakeAck,
  type HandshakeRejected,
  type McpError,
} from '@shader-studio/shared/mcp-protocol';

import { createLogger, type Logger } from './logger.js';
import { resolveBridgeToken, tokensMatch } from './token.js';
import { SERVER_VERSION } from './version.js';

export const NO_APP =
  'Aucun onglet Shader Studio connecté — lance `pnpm dev` et garde une page ouverte';

export const DEFAULT_TIMEOUT_MS = 8_000;
export const SCREENSHOT_TIMEOUT_MS = 15_000;

const BIND_RETRIES = 20;
const BIND_RETRY_MS = 250;

/** Raised when the app replies with `{ok: false}`. Carries the structured error so callers can branch on `.code`. */
export class McpBridgeError extends Error {
  constructor(public readonly mcpError: McpError) {
    super(mcpError.message);
    this.name = 'McpBridgeError';
  }
}

interface Session {
  id: string;
  socket: WebSocket;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  type: ControllerCommandType;
  /** Only a response from the session that a request was sent to may resolve it. */
  sessionId: string;
}

let activeSession: Session | null = null;
let activeBridge: WebSocketServer | null = null;

const pending = new Map<string, PendingRequest>();

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

/** Rejects every pending request belonging to one session. Used on disconnect and on shutdown. */
function rejectPendingFor(sessionId: string, reason: string): void {
  for (const [id, entry] of pending) {
    if (entry.sessionId !== sessionId) continue;
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
    pending.delete(id);
  }
}

function rejectAllPending(reason: string): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
  pending.clear();
}

function send(socket: WebSocket, message: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

/**
 * Handles one message from the *active* session, once its handshake has been
 * accepted. Everything here is a response to a request `callApp` made.
 *
 * Every step is a chance to reject rather than trust: an envelope that does
 * not parse, an id nobody is waiting on (stale, or from a session that is no
 * longer active), and a `result` that does not match the schema for the
 * command that request actually was, are all handled explicitly instead of
 * being cast and hoped for.
 */
function handleAppMessage(raw: string, sessionId: string): void {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  const envelope = AppResponseEnvelopeSchema.safeParse(message);
  if (!envelope.success) return;

  const response = envelope.data;
  const entry = pending.get(response.id);
  if (!entry || entry.sessionId !== sessionId) return;

  clearTimeout(entry.timer);
  pending.delete(response.id);

  if (!response.ok) {
    entry.reject(new McpBridgeError(response.error));
    return;
  }

  const resultSchema = COMMAND_SCHEMAS[entry.type].result;
  const result = resultSchema.safeParse(response.result);
  if (!result.success) {
    entry.reject(
      new McpBridgeError(
        mcpError('INTERNAL', `The app's response to "${entry.type}" did not match its schema`),
      ),
    );
    return;
  }

  entry.resolve(result.data);
}

function rejectHandshake(socket: WebSocket, reason: string): void {
  const message: HandshakeRejected = { kind: 'hello-rejected', reason };
  send(socket, message);
  socket.close();
}

function protocolMismatchReason(handshake: Handshake): string {
  return (
    `Protocol mismatch: the app is v${handshake.appVersion} speaking protocol ` +
    `${handshake.protocolVersion}; shader-studio-mcp is v${SERVER_VERSION} and supports ` +
    `protocol ${MCP_BRIDGE_PROTOCOL_VERSION}. Update whichever side is behind.`
  );
}

/**
 * The first message on every connection must be a valid, correctly-tokened
 * handshake. Anything else — malformed JSON, a schema mismatch, a wrong or
 * missing token, a second connection while one is already active — is an
 * explicit rejection, never a silent takeover of `activeSession`.
 */
function handleHandshake(socket: WebSocket, raw: string, logger: Logger): void {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    rejectHandshake(socket, 'The handshake was not valid JSON.');
    return;
  }

  const parsed = HandshakeSchema.safeParse(message);
  if (!parsed.success) {
    rejectHandshake(socket, 'The handshake did not match the expected shape.');
    return;
  }

  const handshake: Handshake = parsed.data;

  if (handshake.protocolVersion !== MCP_BRIDGE_PROTOCOL_VERSION) {
    rejectHandshake(socket, protocolMismatchReason(handshake));
    return;
  }

  if (!tokensMatch(handshake.token, resolveBridgeToken().value)) {
    rejectHandshake(socket, 'Invalid or missing token.');
    return;
  }

  if (activeSession?.socket.readyState === WebSocket.OPEN) {
    rejectHandshake(socket, 'Another session is already connected.');
    return;
  }

  activeSession = { id: handshake.sessionId, socket };
  logger.info(`App session "${handshake.sessionId}" connected (app v${handshake.appVersion}).`);

  const ack: HandshakeAck = {
    kind: 'hello-ack',
    sessionId: handshake.sessionId,
    protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
  };
  send(socket, ack);

  socket.on('message', (data) => handleAppMessage(messageText(data), handshake.sessionId));
  socket.on('close', () => {
    if (activeSession?.socket === socket) {
      rejectPendingFor(handshake.sessionId, 'The app session disconnected.');
      activeSession = null;
      logger.info(`App session "${handshake.sessionId}" disconnected.`);
    }
  });
}

function wireBridge(wss: WebSocketServer, logger: Logger): void {
  wss.on('connection', (socket) => {
    // A malformed frame (e.g. one over `maxPayload`) surfaces as an 'error'
    // event on this specific socket. Without a listener here, Node treats an
    // unheard 'error' event as fatal and crashes the process — an oversized
    // or corrupt message from one connection must never take the bridge down.
    socket.on('error', (error) => {
      logger.debug(`Connection error: ${error instanceof Error ? error.message : String(error)}`);
    });
    // Only the first message may be a handshake; once accepted, `handleHandshake`
    // replaces this listener with `handleAppMessage` for the rest of the socket's life.
    socket.once('message', (data) => handleHandshake(socket, messageText(data), logger));
  });
}

/**
 * Called once `listenOnce` has already resolved — i.e. once binding is known
 * to have succeeded. (A `wss.on('listening', ...)` handler here would be too
 * late: `listenOnce` already consumed that one-shot event via `.once()` to
 * resolve its promise, so a second listener attached afterward would never fire.)
 */
function logListening(port: number, host: string, logger: Logger): void {
  logger.info(`WebSocket bridge listening on ws://${host}:${port}`);

  const token = resolveBridgeToken();
  if (token.source === 'generated') {
    logger.info(`Bridge token (auto-generated): ${token.value}`);
    logger.info(
      'Pair the app with this token — in the browser console, run: ' +
        `localStorage.setItem("shaderStudioMcpToken", "${token.value}"), then reload.`,
    );
  } else {
    logger.info('Using the configured SHADER_STUDIO_MCP_TOKEN.');
  }
}

function listenOnce(port: number, host: string): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({
      host,
      port,
      maxPayload: MCP_LIMITS.maxMessageBytes,
    });

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

export async function startBridge(
  port: number,
  host = '127.0.0.1',
  logger: Logger = createLogger('silent'),
): Promise<WebSocketServer> {
  if (activeBridge) return activeBridge;

  for (let attempt = 0; attempt <= BIND_RETRIES; attempt++) {
    try {
      const wss = await listenOnce(port, host);
      const boundPort = port === 0 ? (wss.address() as { port: number }).port : port;
      wireBridge(wss, logger);
      logListening(boundPort, host, logger);
      activeBridge = wss;
      return wss;
    } catch (error) {
      if (!isAddrInUse(error) || attempt === BIND_RETRIES) throw error;
      await wait(BIND_RETRY_MS);
    }
  }

  throw new Error(`Could not bind ws://${host}:${port}`);
}

export function installBridgeShutdown(
  wss: WebSocketServer,
  logger: Logger = createLogger('silent'),
): void {
  const shutdown = (reason: string) => {
    logger.info(`Shutting down (${reason}).`);
    rejectAllPending('Bridge shutting down');
    activeSession = null;
    activeBridge = null;
    wss.close();
    process.exit(0);
  };

  process.stdin.on('end', () => shutdown('stdin closed'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

export async function closeBridge(wss: WebSocketServer): Promise<void> {
  rejectAllPending('Bridge closed');
  activeSession = null;
  if (activeBridge === wss) activeBridge = null;

  await new Promise<void>((resolve, reject) => {
    wss.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function callApp<T extends ControllerCommandType>(
  command: Extract<ControllerCommand, { type: T }>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ControllerResultMap[T]> {
  if (!activeSession || activeSession.socket.readyState !== WebSocket.OPEN) {
    throw new Error(NO_APP);
  }

  const id = randomUUID();
  const request = { id, ...command };

  const validated = ControllerRequestSchema.safeParse(request);
  if (!validated.success) {
    throw new Error(
      `Refusing to send an invalid "${command.type}" request: ${validated.error.message}`,
    );
  }

  const session = activeSession;

  return new Promise<ControllerResultMap[T]>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout waiting for "${command.type}"`));
    }, timeoutMs);

    pending.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timer,
      type: command.type,
      sessionId: session.id,
    });

    session.socket.send(JSON.stringify(validated.data));
  });
}

export function resetBridgeForTests(): void {
  activeSession = null;
  activeBridge = null;
  rejectAllPending('Bridge reset');
}
