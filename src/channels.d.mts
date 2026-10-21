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
  /** One gray plane or three RGB planes. CMYK uses three color planes plus one black extra channel and its ICC. */
  color: readonly [ChannelSamples] | readonly [ChannelSamples, ChannelSamples, ChannelSamples];
  /** At most 256, each with its own precision and sampling. */
  extraChannels?: readonly ExtraChannel[];
}
export interface ChannelOptions extends ChannelPrecision {
  quality?: 100;
  groupSize?: 128 | 256 | 512 | 1024;
  predictor?: 'auto' | 'zero' | 'left' | 'top' | 'average' | 'gradient';
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
  icc?: Uint8Array;
  iccCompression?: ICCCompression;
  level?: 5 | 10;
}
/** Keep every supplied plane without a pixel-domain color conversion. Upsampling reconstructs the display-sized image. */
export function encodeChannels(image: PlanarImage, options?: ChannelOptions): Bytes;
/** Validate immediately, then yield between groups. Compatible 8-bit planes use one temporary RGBA copy. */
export function encodeChannelsSteps(image: PlanarImage, options?: ChannelOptions): Job;
