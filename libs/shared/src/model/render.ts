export interface BloomSettings {
  enabled: boolean;
  strength: number;
  radius: number;
  threshold: number;
}

export interface RenderSettings {
  bloom: BloomSettings;
}

export const DEFAULT_BLOOM: BloomSettings = {
  enabled: false,
  strength: 0.3,
  radius: 0.5,
  threshold: 0.85,
};

export const DEFAULT_RENDER: RenderSettings = { bloom: { ...DEFAULT_BLOOM } };
