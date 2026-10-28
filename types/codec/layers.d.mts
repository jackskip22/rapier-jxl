// SPDX-License-Identifier: MIT
import type {Bytes, Job, Limits} from './index.mjs';
import type {PlanarImage, ChannelOptions} from './channels.mjs';
export type {Bytes, Job, PlanarImage} from './channels.mjs';
export const LIMITS: Limits;
export const LAYER_BLEND_MODES: Readonly<{replace: 0; add: 1; blend: 2; muladd: 3; multiply: 4}>;
export type LayerBlendMode = keyof typeof LAYER_BLEND_MODES;
export interface LayerBlend {
  blend?: LayerBlendMode;
  /** Saved reference slot; defaults to the preceding visible layer, or initial blank slot 0. */
  source?: 0 | 1 | 2 | 3;
  /** Zero-based extra-channel index, at most 10. */
  alpha?: number;
  clamp?: boolean;
}
export interface Layer extends LayerBlend {
  /** A planar image, or encoded bytes from a compatible one-frame encoder. */
  image?: PlanarImage;
  bytes?: Uint8Array;
  x?: number;
  y?: number;
  /** Nonfinal visible layers save to slot 3 by default; explicit slots 0..3 are available. */
  saveAs?: 0 | 1 | 2 | 3;
  referenceOnly?: boolean;
  skipProgressive?: boolean;
  beforeColorTransform?: boolean;
  name?: string;
  extraBlending?: readonly (LayerBlendMode | LayerBlend)[];
  options?: Pick<ChannelOptions, 'groupSize' | 'predictor' | 'upsampling'>;
}
export interface LayeredImage {width: number; height: number; layers: readonly Layer[]}
export interface LayerOptions extends Omit<ChannelOptions, 'preview'> {
  /** Authored preview of the final composition, sharing its color and channel metadata. */
  preview?: PlanarImage;
}
/** Author one composite still; the image metadata and color meaning are shared by every layer. */
export function encodeLayers(image: LayeredImage, options?: LayerOptions): Bytes;
export function encodeLayersSteps(image: LayeredImage, options?: LayerOptions): Job;
