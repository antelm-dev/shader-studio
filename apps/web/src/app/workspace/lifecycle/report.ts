import { ApiError } from '../../api/shader-api';
import type { OutputLog } from '../../ui/bottom-panel/output-log';
import type { DocumentState } from '../state/document-state';

/**
 * One failed workspace operation, reported once.
 *
 * Three destinations, deliberately: the notice the user is looking at, the
 * Output panel that keeps the history, and the console for whoever has the
 * devtools open. Shared by `ShaderStore` and the lifecycle owners so that a
 * failure routed through either produces exactly one message of each kind —
 * duplicating this by hand in each caller is how a single failure ends up
 * saying the same thing twice.
 */
export function reportWorkspaceError(
  error: unknown,
  documentState: DocumentState,
  outputLog: OutputLog,
): void {
  const message = error instanceof ApiError ? error.summary : String(error);
  console.error('[shader-store]', error);
  documentState.notify(message, true);
  outputLog.error('workspace', message);
}
