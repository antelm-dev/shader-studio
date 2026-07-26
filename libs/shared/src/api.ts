import type { TextureChannelSettingsPatch } from './model';
import type { ShaderProject } from './project';

/** Mutable shader fields accepted by both HTTP and desktop transports. */
export interface UpdateShaderPatch {
  name?: string;
  description?: string;
  controls?: unknown;
  render?: unknown;
  fragment?: string;
  vertex?: string;
  project?: ShaderProject;
  channels?: readonly TextureChannelSettingsPatch[];
  /**
   * The `revision` the client last read. When present, the write is rejected
   * with a `conflict` if the stored revision has moved on since — optimistic
   * concurrency. Omit it for last-writer-wins (the historical behaviour).
   */
  expectedRevision?: number;
}
