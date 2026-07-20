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
}
