import type { TextureFilterMode, TextureWrapMode } from '../model';

export const PROJECT_VERSION = 1;

export type PassKind = 'image' | 'common' | 'buffer';

export type BufferSlot = 'A' | 'B' | 'C' | 'D';

export const BUFFER_SLOTS: readonly BufferSlot[] = ['A', 'B', 'C', 'D'];

export const CHANNEL_COUNT = 4;

export type ChannelIndex = 0 | 1 | 2 | 3;

export const CHANNEL_INDICES: readonly ChannelIndex[] = [0, 1, 2, 3];

/**
 * What an `iChannel` slot samples.
 *
 * `feedback` means "the frame that buffer produced last tick" and is not a
 * dependency edge — which is what lets a buffer sample itself.
 */
export type ChannelBinding =
  | { kind: 'none' }
  | { kind: 'buffer'; passId: string; feedback: boolean }
  | { kind: 'texture'; slot: ChannelIndex };

export type ChannelBindings = readonly [
  ChannelBinding,
  ChannelBinding,
  ChannelBinding,
  ChannelBinding,
];

export const NO_BINDING: ChannelBinding = { kind: 'none' };

export function emptyBindings(): ChannelBindings {
  return [{ kind: 'none' }, { kind: 'none' }, { kind: 'none' }, { kind: 'none' }];
}

export function legacyTextureBindings(): ChannelBindings {
  return [
    { kind: 'texture', slot: 0 },
    { kind: 'texture', slot: 1 },
    { kind: 'texture', slot: 2 },
    { kind: 'texture', slot: 3 },
  ];
}

export type PassResolutionMode = 'viewport' | 'scaled' | 'fixed';

export interface PassResolution {
  mode: PassResolutionMode;
  scale: number;
  width: number;
  height: number;
}

export const DEFAULT_PASS_RESOLUTION: PassResolution = {
  mode: 'viewport',
  scale: 1,
  width: 512,
  height: 512,
};

export const RESOLUTION_LIMITS = {
  scale: { min: 0.05, max: 4 },
  size: { min: 1, max: 4096 },
} as const;

export interface RenderPass {
  id: string;
  kind: PassKind;
  name: string;
  slot: BufferSlot | null;
  enabled: boolean;
  source: string;
  channels: ChannelBindings;
  resolution: PassResolution;
  filter: TextureFilterMode;
  wrap: TextureWrapMode;
}

export interface ShaderFile {
  id: string;
  name: string;
  source: string;
}

export interface ShaderProject {
  version: number;
  vertex: string;
  passes: RenderPass[];
  files: ShaderFile[];
}
