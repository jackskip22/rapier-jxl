// SPDX-License-Identifier: MIT
import type {Bytes, Job, Limits} from './index.mjs';
import type {ColorEncoding, ToneMapping, ICCCompression, ExtendedTransferFunction} from './icc.mjs';
export type {Bytes, Job} from './index.mjs';
export const LIMITS: Limits;
export const EXTRA_CHANNEL_TYPES: Readonly<{alpha: 0; depth: 1; spot: 2; selection: 3; black: 4; cfa: 5; thermal: 6; optional: 16}>;
export type ExtraChannelType = keyof typeof EXTRA_CHANNEL_TYPES;
export type ChannelSamples = Uint8Array | Uint8ClampedArray | Uint16Array | Uint32Array | Float32Array;
export interface ChannelPrecision {
  /** Integer precision 1..31. Floating precision has 2..8 exponent and 2..23 mantissa bits plus its sign. */
  bitDepth?: number;
  /** uint by default, except Float32Array. float16 and float32 mean IEEE layouts; float admits other raw words. */
  sampleFormat?: 'uint' | 'float16' | 'float32' | 'float';
  exponentBits?: number;
}
export interface ExtraChannel extends ChannelPrecision {
  type: ExtraChannelType;
  data: ChannelSamples;
  /** Metadata reduction, 0..3. Coded dimensions use 2^dimShift times upsampling. */
  dimShift?: 0 | 1 | 2 | 3;
  upsampling?: 1 | 2 | 4 | 8;
  /** At most 1071 UTF-8 bytes. */
  name?: string;
  alphaPremultiplied?: boolean;
  /** Spot channels: normalized red, green, blue and solidity. */
  spotColor?: readonly [number, number, number, number];
  /** CFA channels: index from 0 to 274. */
  cfaChannel?: number;
}
export interface PlanarImage {
  width: number;
  height: number;
  /** One gray plane or three profile-defined components. CMYK uses three color planes plus one black extra
   * channel and its ICC. Original XYB uses already-scaled XYB values; no source color conversion is performed. */
  color: readonly [ChannelSamples] | readonly [ChannelSamples, ChannelSamples, ChannelSamples];
  /** At most 256, each with its own precision and sampling. */
  extraChannels?: readonly ExtraChannel[];
}
export interface SqueezeStep {
  axis: 'x' | 'y';
  /** Insert residual planes after the selected range (default true), or append them. */
  inPlace?: boolean;
  /** First channel in the current transformed order, 0..9287 (default 0). */
  beginChannel?: number;
  /** Number of consecutive channels, 1..19; defaults to the original plane count. */
  channelCount?: number;
}
export interface WeightedPredictor {
  /** Seven coefficients are 0..31. Defaults: 16, 10, and [7,7,7,0,0]. */
  p1?: number;
  p2?: number;
  p3?: ArrayLike<number>;
  /** Four weights are 0..15; defaults [13,12,12,12]. Zero weights remain valid. */
  weights?: ArrayLike<number>;
}
export interface PlanarRCT {
  type: 'rct';
  /** First of three equal-sized, equally sampled channels in current transformed order. Default 0. */
  beginChannel?: number;
  /** All 42 permutation/lifting recipes, 0..41. Default 6 (YCoCg). Arithmetic wraps as signed 32-bit words. */
  rctType?: number;
}
export interface PlanarPalette {
  type: 'palette';
  beginChannel?: number;
  /** Consecutive equally sized/sampled channels. Defaults to the original color count. */
  channelCount?: number;
  /** colors is exact dictionary coding. implicit also uses fixed differences/cubes. Explicit delta tables
   * (explicit/hybrid) are opt-in: pinned jxl-oxide 0.12.6 decodes their table width incorrectly. */
  mode?: 'colors' | 'implicit' | 'explicit' | 'hybrid';
  /** Uses reconstructed whole-plane neighbors. Default zero for colors, left otherwise. */
  predictor?: 'zero' | 'left' | 'top' | 'average' | 'select' | 'gradient' | 'weighted';
  /** Optional fixed dictionaries, in index order. Each vector has channelCount signed/unsigned 32-bit
   * integer words. Missing colors are refused; omission builds a deterministic dictionary from the input. */
  colors?: readonly ArrayLike<number>[];
  deltas?: readonly ArrayLike<number>[];
  /** Absolute-color bound, 0..70911; default 4096, or the authored colors length. */
  maxColors?: number;
  /** Explicit-delta bound, 0..66816; default 256, or the authored deltas length. */
  maxDeltaEntries?: number;
}
export type PlanarTransform = PlanarRCT | PlanarPalette;
export interface ChannelOptions extends ChannelPrecision {
  quality?: 100;
  groupSize?: 128 | 256 | 512 | 1024;
  predictor?: 'auto' | 'zero' | 'left' | 'top' | 'average' | 'gradient' | 'weighted';
  /** Ordered reversible RCT/palette recipes before Squeeze. Each palette prepends a global table, so later
   * indices use that transformed order. Default Squeeze excludes tables; explicit table Squeeze must stay
   * within the meta-channel range and insert residuals in place. Omission/false/[] preserve the default path.
   * These explicit recipes do not run the automatic RGBA candidate search. */
  transforms?: false | readonly PlanarTransform[];
  /** Author an explicit reversible recipe. default expands the standard recipe into explicit steps.
   * A sequence whose signed arithmetic differs between independent decoders is refused before output. */
  squeeze?: false | 'default' | readonly SqueezeStep[];
  /** Resolution passes. true/resolution writes quarter, half, then full detail; custom scales strictly
   * decrease through 8, 4, 2, 1 and end at one (2..4 passes). An omitted squeeze selects default Squeeze;
   * squeeze:false keeps original planes, whose fine samples then arrive in the last pass. Preview frames
   * retain one pass. The existing Squeeze arithmetic/memory bounds apply. */
  progressive?: boolean | 'resolution' | {passes: readonly (1 | 2 | 4 | 8)[]};
  /** Supplying coefficients selects weighted prediction; an explicit different predictor is refused. */
  weightedPredictor?: WeightedPredictor;
  /** Retained transform scratch bound, default 256 MiB; integer 1..2 GiB. Source arrays stay caller-owned. */
  maxTransformBytes?: number;
  /** Stored color dimensions are ceil(width/upsampling) by ceil(height/upsampling). */
  upsampling?: 1 | 2 | 4 | 8;
  /** JPEG XL symmetric kernels, 15, 55 or 210 binary16 coefficients respectively. */
  upsamplingWeights?: {2?: ArrayLike<number>; 4?: ArrayLike<number>; 8?: ArrayLike<number>};
  orientation?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  intrinsicSize?: {width: number; height: number};
  /** Optional separate preview. A generated preview samples the source; an authored one must share channel metadata. */
  preview?: {maxDimension: number} | PlanarImage;
  colorSpace?: 'srgb' | 'display-p3' | 'rec2020';
  transferFunction?: ExtendedTransferFunction;
  colorEncoding?: ColorEncoding;
  toneMapping?: ToneMapping;
  intensityTarget?: number;
  /** Exact ICC.1 profile for the supplied components. Specialized source spaces need a matching viewer CMS. */
  icc?: Uint8Array;
  iccCompression?: ICCCompression;
  level?: 5 | 10;
}
/** Keep every supplied plane without a pixel-domain color conversion. Upsampling reconstructs the display-sized image. */
export function encodeChannels(image: PlanarImage, options?: ChannelOptions): Bytes;
/** Validate immediately, then yield between groups. Compatible 8-bit planes use one temporary RGBA copy. */
export function encodeChannelsSteps(image: PlanarImage, options?: ChannelOptions): Job;
