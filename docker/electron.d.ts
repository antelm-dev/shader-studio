/**
 * Container-build replacement for `apps/renderer/src/electron.d.ts`.
 *
 * The real declaration types `window.electron` by importing from the desktop preload,
 * which drags the whole Electron main process — and its workspace dependency
 * `electron-ipc-module` — into the TypeScript program. Neither is available in
 * the image, and neither has anything to do with the web build: the desktop
 * bridge is only reachable from `main.desktop.ts`, which the server build never
 * touches. Typing it loosely here keeps the app compiling without them.
 *
 * A plain `any` is not enough: callbacks handed to the bridge — whether passed
 * straight to it or to the `.then()` of what it returns — would lose their
 * contextual type and trip `noImplicitAny`. The node type below stays callable,
 * indexable and thenable at every depth, so those callbacks keep typed
 * parameters.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// The callback overload has to come first, and its parameter has to be a
// function type: an `any` parameter gives an arrow argument no contextual type,
// which is what `noImplicitAny` complains about.
interface DesktopBridgeNode {
  (callback: (...args: any[]) => void): Promise<any> & DesktopBridgeNode;
  (a?: any, b?: any, c?: any, d?: any): Promise<any> & DesktopBridgeNode;
  [key: string]: DesktopBridgeNode;
}

declare global {
  interface Window {
    electron: DesktopBridgeNode;
  }
}

export {};
