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
  write(output: RuntimeOutput, signal: AbortSignal): Promise<DeliveryResult>;
}

/** Browser: one stored ZIP holding `<stem>/<files>`, downloaded. */
export class ZipDownloadWriter implements ProjectWriter {
  constructor(private readonly download: (blob: Blob, filename: string) => void = saveBlob) {}

  async write(output: RuntimeOutput, signal: AbortSignal): Promise<DeliveryResult> {
    const zip = new ZipBuilder();
    for (const file of output.files) {
      signal.throwIfAborted();
      await zip.add(`${output.stem}/${file.path}`, new Blob([file.bytes.slice()]));
    }
    signal.throwIfAborted();
    const filename = `${output.stem}.zip`;
    this.download(zip.finish(), filename);
    return { status: 'written', where: filename };
  }
}

/** Desktop: a new folder inside one the user picks, written by the main process. */
export class DesktopFolderWriter implements ProjectWriter {
  async write(output: RuntimeOutput, signal: AbortSignal): Promise<DeliveryResult> {
    signal.throwIfAborted();
    const result = await window.electron.bridge.files.saveProjectFolder(
      output.stem,
      output.files.map((file) => ({ path: file.path, bytes: file.bytes })),
    );
    if (result.status === 'error') throw new Error(result.message);
    if (result.status === 'cancelled') return { status: 'cancelled' };
    return { status: 'written', where: result.value.path };
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
