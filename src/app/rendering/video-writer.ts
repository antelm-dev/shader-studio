import type { DesktopPlatform } from '../desktop/desktop-platform';
import type { CapturePlan } from '@shader-studio/shared/capture-plan';

/**
 * Where an encoded video goes.
 *
 * Frames arrive as canvases — already drawn, already sized — and leave as one
 * WebM. The writer owns the encoder: opening it asks where the file should land
 * (desktop) or prepares a download (browser), writing feeds WebCodecs, and
 * finishing seals the container.
 */
export interface VideoWriter {
  /** Encodes one output frame. `index` is the timeline position, including loops. */
  write(canvas: HTMLCanvasElement, index: number): Promise<void>;
  /** Seals the WebM and says where it ended up. */
  finish(): Promise<string>;
  /** Throws the encode away. A half-written file is never left behind. */
  cancel(): Promise<void>;
}

/**
 * Opens a WebM encode for the given plan.
 *
 * `null` means the user declined the save dialog on desktop. A missing codec
 * throws — that is a real failure, not a cancelled picker.
 */
export async function openVideo(
  desktop: DesktopPlatform,
  stem: string,
  plan: CapturePlan,
): Promise<VideoWriter | null> {
  const session = desktop.available ? await desktop.beginVideo(stem) : null;
  if (desktop.available && !session) return null;

  const {
    BufferTarget,
    Output,
    QUALITY_HIGH,
    VideoSample,
    VideoSampleSource,
    WebMOutputFormat,
    getFirstEncodableVideoCodec,
  } = await import('mediabunny');

  const format = new WebMOutputFormat();
  const codec = await getFirstEncodableVideoCodec(format.getSupportedVideoCodecs(), {
    width: plan.width,
    height: plan.height,
  });
  if (!codec) {
    if (session) await desktop.abortVideo(session.id).catch(() => undefined);
    throw new Error('This browser cannot encode WebM video (WebCodecs required).');
  }

  const target = new BufferTarget();
  const output = new Output({ format, target });
  const source = new VideoSampleSource({
    codec,
    bitrate: QUALITY_HIGH,
    latencyMode: 'quality',
  });
  output.addVideoTrack(source);
  await output.start();

  const frameDuration = 1 / plan.settings.fps;
  let closed = false;

  return {
    async write(canvas, index) {
      if (closed) return;
      const sample = new VideoSample(canvas, {
        timestamp: index * frameDuration,
        duration: frameDuration,
      });
      try {
        await source.add(sample);
      } finally {
        sample.close();
      }
    },

    async finish() {
      if (closed) throw new Error('This video export is already closed');
      closed = true;
      source.close();
      await output.finalize();

      const buffer = target.buffer;
      if (!buffer) throw new Error('The encoder produced no output');

      const bytes = new Uint8Array(buffer);
      const filename = `${stem}.webm`;

      if (session) {
        const path = await desktop.commitVideo(session.id, bytes);
        return `Saved ${path}`;
      }

      const blob = new Blob([bytes], { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
      return `Downloaded ${filename}`;
    },

    async cancel() {
      if (closed) return;
      closed = true;
      await output.cancel().catch(() => undefined);
      if (session) await desktop.abortVideo(session.id).catch(() => undefined);
    },
  };
}
