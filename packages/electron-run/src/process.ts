import cp from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** ANSI sequence that clears the screen and the scrollback buffer. */
const CLEAR_SEQUENCE = '\x1b[2J\x1b[3J\x1b[H';

/** Resolve the absolute path to the Electron binary via the `electron` package. */
export function resolveElectronBinary(): string {
  return require('electron') as string;
}

/**
 * Terminate a process and its whole tree.
 *
 * On Windows this shells out to `taskkill /T /F`; elsewhere it sends `SIGTERM`
 * and tolerates an already-dead process (`ESRCH`).
 */
export function killTree(pid: number | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!pid) {
      resolve();
      return;
    }

    if (process.platform === 'win32') {
      cp.execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => resolve());
      return;
    }

    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ESRCH') {
        reject(error);
        return;
      }
    }

    resolve();
  });
}

/** Clear the terminal by writing an ANSI reset sequence to stdout. */
export function clearTerminal(): void {
  process.stdout.write(CLEAR_SEQUENCE);
}
