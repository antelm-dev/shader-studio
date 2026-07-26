/** Ripple slots the engine reserves in `u_clickData`. Mirrors `__MAX_WAVES__`. */
export const MAX_WAVES = 24;

/**
 * A shader parameter's uniform is always its control key prefixed with `u_`:
 * a control keyed `warpIntensity` feeds `uniform float u_warpIntensity`.
 */
export const UNIFORM_PREFIX = 'u_';

export type ControlType = 'number' | 'boolean' | 'color' | 'select';

interface ControlBase {
  key: string;
  label?: string;
  folder?: string;
}

export interface NumberControl extends ControlBase {
  type: 'number';
  default: number;
  min: number;
  max: number;
  step?: number;
}

export interface BooleanControl extends ControlBase {
  type: 'boolean';
  default: boolean;
}

export interface ColorControl extends ControlBase {
  type: 'color';
  default: string;
}

export interface SelectControl extends ControlBase {
  type: 'select';
  default: number;
  options: Record<string, number>;
}

export type ShaderControl = NumberControl | BooleanControl | ColorControl | SelectControl;

export type ParamValue = number | boolean | string;

export type ShaderParams = Record<string, ParamValue>;
