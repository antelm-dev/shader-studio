/**
 * `edcore.main` (the editor plus all of its contributions, with no bundled
 * languages — see `monaco-loader.ts`) ships no type declarations of its own.
 * It re-exports exactly the API that `editor.api` declares.
 */
declare module 'monaco-editor/esm/vs/editor/edcore.main.js' {
  export * from 'monaco-editor/esm/vs/editor/editor.api.js';
}
