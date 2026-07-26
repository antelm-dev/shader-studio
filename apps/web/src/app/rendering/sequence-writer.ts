import type { DesktopPlatform } from '../desktop/desktop-platform';
import { frameName, sequencePadding, type CapturePlan } from '@shader-studio/shared/capture-plan';
import { ZipBuilder } from './zip';

/**
 * Where an image sequence goes.
 *
 * The two platforms want opposite things and there is no honest way to pretend
 * otherwise. On the desktop a sequence is what it should be — a folder of
 * numbered PNGs, written one at a time, ready for `ffmpeg -i frame-%04d.png`.
 * A browser cannot write a folder, and will not be given the chance to try a
 * thousand downloads, so it gets the same files inside one stored ZIP.
 *
 * What both share is the shape: frames arrive in order, and the writer decides
 * what that means.
 */
export interface SequenceWriter {
  /** Writes one frame. The index is the *output* index, so a looped capture repeats. */
  write(index: number, blob: Blob): Promise<void>;
  /** Seals the sequence, and says where it ended up. */
  finish(): Promise<string>;
  /** Throws the sequence away. A half-written folder is worse than none. */
  cancel(): Promise<void>;
}

/**
 * Opens somewhere to put the frames, asking the user where.
 *
 * `null` means they declined — a cancelled folder picker, not a failure, and the
 * caller should say nothing about it.
 */
export async function openSequence(
  desktop: DesktopPlatform,
  stem: string,
  plan: CapturePlan,
): Promise<SequenceWriter | null> {
  const count = plan.outputFrames;
  const padding = sequencePadding(count);

  if (desktop.available) {
    const session = await desktop.beginSequence(stem, padding);
    if (!session) return null;
    return desktopSequence(desktop, session);
  }

  return browserSequence(stem, count);
}

/**
 * The desktop writer holds no frames at all: each one goes down the wire and
 * onto the disk as it is made. A 4K capture is gigabytes, and the difference
 * between streaming it and collecting it is the difference between an export and
 * a renderer process that dies at frame six hundred.
 */
function desktopSequence(
  desktop: DesktopPlatform,
  session: { id: string; directory: string },
): SequenceWriter {
  return {
    async write(index, blob) {
      await desktop.writeFrame(session.id, index, new Uint8Array(await blob.arrayBuffer()));
    },
    async finish() {
      const result = await desktop.endSequence(session.id, false);
      return result ? `${result.frames} frames written to ${result.directory}` : session.directory;
    },
    async cancel() {
      await desktop.endSequence(session.id, true);
    },
  };
}

/** In the browser the frames pile up as blobs — which the browser is free to keep on disk — and ship as one ZIP. */
function browserSequence(stem: string, count: number): SequenceWriter {
  const zip = new ZipBuilder();

  return {
    async write(index, blob) {
      await zip.add(frameName(stem, index, count), blob);
    },
    async finish() {
      const archive = zip.finish();
      const url = URL.createObjectURL(archive);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${stem}-frames.zip`;
      link.click();
      URL.revokeObjectURL(url);
      return `${zip.size} frames downloaded as ${link.download}`;
    },
    async cancel() {
      // Nothing was written anywhere: the blobs go when the builder does.
    },
  };
}
