// SPDX-License-Identifier: MIT
import type {Bytes, Job} from './index.mjs';
import type {PlanarImage, ChannelOptions} from './channels.mjs';
export type PatchBlend = 'none' | 'replace' | 'add' | 'multiply' | 'blend-above' | 'blend-below'
  | 'alpha-weighted-add-above' | 'alpha-weighted-add-below';
/** Normative patch blend modes, in their codestream order 0 through 7. */
export const PATCH_BLEND_MODES: readonly PatchBlend[];
export interface PatchPosition {
  /** Destination top-left pixel. The complete rectangle must fit inside the image. */
  x: number;
  y: number;
  /** Color blend, default replace. Geometry and blends are applied in the supplied order. */
  blend?: PatchBlend;
  /** Alpha blend, default the color blend. Color blend-above/below also sets composite alpha. */
  alphaBlend?: PatchBlend;
  /** Clamp foreground factors to [0,1] for multiply or alpha-aware modes, default false. */
  clamp?: boolean;
  /** Same for alpha; defaults to clamp when the alpha mode uses clamping. */
  alphaClamp?: boolean;
}
export interface AuthoredPatch {
  sourceX: number;
  sourceY: number;
  width: number;
  height: number;
  positions: readonly PatchPosition[];
}
export interface PatchOptions {
  atlas: {data: Uint8Array | Uint8ClampedArray; width: number; height: number};
  patches: readonly AuthoredPatch[];
  colorSpace?: 'srgb' | 'display-p3';
  /** Exact encoding search, integer 1..9, default 1. */
  effort?: number;
  /** Optional base RGB quantization, integer 0..127; maximum error before blending, default 0.
   * Atlas samples, alpha and fully transparent base RGB remain exact. Replacement patches stay exact. */
  baseError?: number;
  orientation?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  /** Default 5. Explicit 10 allows larger total patch area; Chrome 155 still applies the level-5 area bound. */
  level?: 5 | 10;
}
/** Encode a base and arbitrary source atlas with all eight patch blend modes. Straight RGBA8 only.
 * Both input buffers and geometry remain owned by the caller and must stay unchanged during a stepped job.
 * At most floor(image pixels/16) source rectangles and four times that many placements.
 * All pixels in replacement patches, including hidden RGB and alpha, are copied exactly.
 * Arithmetic can exceed [0,1] before final conversion. For alpha above one, Chrome 155's default
 * createImageBitmap premultiplication differs; ImageDecoder or {premultiplyAlpha: 'none'} retains the result. */
export function encodePatches(data: Uint8Array | Uint8ClampedArray, width: number, height: number, options: PatchOptions): Bytes;
/** Same result as encodePatches. Hurry retains complete authored output; cancellation leaves bytes null. */
export function encodePatchesSteps(data: Uint8Array | Uint8ClampedArray, width: number, height: number, options: PatchOptions): Job;

export interface PatchChannelBlend {
  blend?: PatchBlend;
  /** Index of an alpha extra channel. Defaults to the first alpha channel, or zero with no extras. */
  alpha?: number;
  clamp?: boolean;
}
export interface PatchCompositionPosition extends PatchChannelBlend {
  /** Destination coordinates before the base frame's spatial upsampling. */
  x: number;
  y: number;
  /** One blend per extra channel; omission follows the color blend. Color-over also writes its selected composite alpha. */
  extraBlending?: readonly (PatchBlend | PatchChannelBlend)[];
}
export interface CompositionPatch {
  /** Saved slot 0..3. Omission selects the first supplied reference. */
  reference?: 0 | 1 | 2 | 3;
  /** Source coordinates in the saved reference after its spatial upsampling. */
  sourceX: number;
  sourceY: number;
  width: number;
  height: number;
  positions: readonly PatchCompositionPosition[];
}
export interface PatchFrameSource {
  /** Exactly one of image or bytes. Encoded bytes must be one independent, full replacement frame. */
  image?: PlanarImage;
  bytes?: Uint8Array;
  /** Planar coding choices only. Image precision, channel metadata and color meaning are shared. */
  options?: Pick<ChannelOptions, 'groupSize' | 'predictor' | 'weightedPredictor' | 'upsampling' | 'transforms' |
    'squeeze' | 'progressive' | 'maxTransformBytes'>;
}
export interface PatchReferenceSource extends PatchFrameSource {slot: 0 | 1 | 2 | 3}
export interface PatchComposition {
  base: PatchFrameSource;
  /** One to four distinct slots; each reference is saved before color conversion and has one coding pass. */
  references: readonly PatchReferenceSource[];
  patches: readonly CompositionPatch[];
}
export interface PatchCompositionOptions extends Omit<ChannelOptions, 'preview'> {
  /** Authored preview of the finished composition. An encoded base owns its existing preview. */
  preview?: PlanarImage;
}
/** Compose arbitrary typed planes and compatible Modular/VarDCT frames with one patch dictionary.
 * Headers retain common channel/color/transform meaning; independent payload sections are not re-encoded.
 * Blending occurs in the decoder's floating-point pre-color domain, including replacement. Wider integer
 * words and nonfinite payloads therefore have the format's rendered-sample semantics, not a raw-word copy promise.
 * Source arrays and encoded streams stay caller-owned and unchanged throughout a stepped job. */
export function encodePatchComposition(image: PatchComposition, options?: PatchCompositionOptions): Bytes;
export function encodePatchCompositionSteps(image: PatchComposition, options?: PatchCompositionOptions): Job;
