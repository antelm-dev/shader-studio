import {
  InjectionToken,
  type EnvironmentProviders,
  isDevMode,
  makeEnvironmentProviders,
} from '@angular/core';

/**
 * Runtime configuration for `McpBridge` — whether it should connect at all,
 * and where.
 *
 * The default factory preserves the previous behavior (connect only in
 * `isDevMode()`, against `location.hostname:4310`) so nothing changes for
 * `pnpm dev`. Production and Electron builds get this disabled by default —
 * `StartupCoordinator` never enables MCP silently — and opt in explicitly by
 * calling `provideMcpBridge()` with their own config in their `providers`
 * array (see `app.config.desktop.ts` for where that would go).
 */
export interface McpBridgeConfig {
  enabled: boolean;
  host: string;
  port: number;
  /** Use `wss://` instead of `ws://`. */
  secure: boolean;
  /**
   * A pre-shared token, for callers that can't rely on `localStorage`
   * (Electron, a deployed build with its own secret-delivery mechanism).
   * Falls back to `localStorage.getItem('shaderStudioMcpToken')` when unset.
   */
  token?: string;
}

function defaultConfig(): McpBridgeConfig {
  return {
    enabled: isDevMode(),
    host: typeof location !== 'undefined' ? location.hostname : '127.0.0.1',
    port: 4310,
    secure: typeof location !== 'undefined' && location.protocol === 'https:',
  };
}

export const MCP_BRIDGE_CONFIG = new InjectionToken<McpBridgeConfig>('MCP_BRIDGE_CONFIG', {
  providedIn: 'root',
  factory: defaultConfig,
});

/**
 * Explicit opt-in for a build that wants MCP enabled outside of
 * `isDevMode()` — a production/Electron shell that knows its own port, host,
 * and token. Never called automatically; a consumer adds it to its own
 * `ApplicationConfig.providers`.
 */
export function provideMcpBridge(config: Partial<McpBridgeConfig>): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: MCP_BRIDGE_CONFIG, useFactory: () => ({ ...defaultConfig(), ...config }) },
  ]);
}
