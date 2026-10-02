/**
 * What the plugin Worker prelude provides (see apps/studio/src/plugin-sandbox.js).
 * Requests arrive as plain data; a handler's return value is sent back as JSON.
 */
declare const shaderStudio: {
  handle(method: string, fn: (params: unknown) => unknown): void;
  notify(data: unknown): void;
};
