/**
 * Monaco's editor worker.
 *
 * It is a side-effect module: importing it installs the worker's message
 * handler. The bundler turns this file into its own chunk, which
 * `MonacoEnvironment.getWorker` (see `monaco-loader.ts`) points a `Worker` at.
 *
 * Only the *editor* worker is needed. GLSL and JSON are both registered as
 * Monarch tokenizers, which run on the main thread, so none of Monaco's
 * language-service workers are pulled in.
 */
import 'monaco-editor/esm/vs/editor/editor.worker.js';
