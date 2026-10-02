/**
 * Delivers what an export runtime assembled: a ZIP download in the browser, a
 * new folder on the desktop. The runtime chose the relative paths; the writer
 * only ever puts them under one stem, and the desktop main process checks
 * them again before anything touches the disk.
 */
import type { RuntimeOutput } from './host-adapters';
import { ZipBuilder } from '../rendering/zip';

export type DeliveryResult = { status: 'written'; where: string } | { status: 'cancelled' };

export interface ProjectWriter {
  /**
   * Deliver `output`. `proceed` is called once the destination is known and
   * before anything is written; it throws to stop. `signal` cancels the
   * delivery, on the desktop all the way into the main process's write.
   */
  write(output: RuntimeOutput, signal: AbortSignal, proceed?: () => void): Promise<DeliveryResult>;
}

/** Browser: one stored ZIP holding `<stem>/<files>`, downloaded. */
export class ZipDownloadWriter implements ProjectWriter {
  constructor(private readonly download: (blob: Blob, filename: string) => void = saveBlob) {}

  async write(
    output: RuntimeOutput,
    signal: AbortSignal,
    proceed: () => void = () => undefined,
  ): Promise<DeliveryResult> {
    const zip = new ZipBuilder();
    for (const file of output.files) {
      signal.throwIfAborted();
      await zip.add(`${output.stem}/${file.path}`, new Blob([file.bytes.slice()]));
    }
    signal.throwIfAborted();
    proceed();
    const filename = `${output.stem}.zip`;
    this.download(zip.finish(), filename);
    return { status: 'written', where: filename };
  }
}

/**
 * Desktop: a new folder inside one the user picks, written by the main
 * process in a session this writer cancels if `signal` aborts — before the
 * write, or during it, in which case the main process stops before its next
 * file or before committing the folder, and nothing is left on disk.
 */
export class DesktopFolderWriter implements ProjectWriter {
  async write(
    output: RuntimeOutput,
    signal: AbortSignal,
    proceed: () => void = () => undefined,
  ): Promise<DeliveryResult> {
    signal.throwIfAborted();
    const files = window.electron.bridge.files;
    const begun = await files.beginProjectFolder(output.stem);
    if (begun.status === 'error') throw new Error(begun.message);
    if (begun.status === 'cancelled') return { status: 'cancelled' };
    const { id } = begun.value;
    const cancel = () => void files.cancelProjectFolder(id);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      // The dialog may have been open for a while: nothing is sent unless the call still holds.
      // (An abort during the dialog fired before the listener existed, so cancel here.)
      try {
        signal.throwIfAborted();
        proceed();
      } catch (error) {
        cancel();
        throw error;
      }
      const result = await files.writeProjectFolder(
        id,
        output.files.map((file) => ({ path: file.path, bytes: file.bytes })),
      );
      // A cancel the main process saw in time comes back as `cancelled`; one that arrived after
      // the folder was committed is too late to undo, and the export is reported as written.
      if (result.status === 'error') throw new Error(result.message);
      if (result.status === 'cancelled') return { status: 'cancelled' };
      return { status: 'written', where: result.value.path };
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
