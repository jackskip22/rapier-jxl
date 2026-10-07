// SPDX-License-Identifier: MIT
import type {Pixels, Bytes, ColorSpace, SampleFormat, TransferFunction, Limits, EncodeOptions, EncoderError, ErrorCode, Job} from './index.mjs';
import type {Orientation} from './jpeg.mjs';
export type {Pixels, Bytes, ColorSpace, SampleFormat, TransferFunction, Limits, EncodeOptions, EncoderError, ErrorCode, Job} from './index.mjs';
export type {Orientation} from './jpeg.mjs';

/** Unchecked composition layers. Call the admission helpers before allocating or writing caller input. */
export const LIMITS: Limits;
export const PHOTO_LIMITS: Limits;
export const JPEG_LIMITS: Limits;
export type Numbers = ArrayLike<number> & Iterable<number>;
export type Plane = Int16Array | Int32Array;
export type Steps<Output = Bytes> = Generator<number, Output, boolean | undefined>;

export class BitWriter {
  constructor(capacity?: number);
  bytes: Bytes;
  at: number;
  acc: number;
  pending: number;
  readonly bitLength: number;
  write(count: number, value: number): void;
  writeU32(choices: readonly (readonly [bits: number, offset: number])[], value: number): void;
  zeroPadToByte(): void;
  grow(need?: number): void;
  append(other: BitWriter): void;
  finish(): Bytes;
}
export function packSigned(value: number): number;
export function floorLog2(value: number): number;
export function ceilLog2(value: number): number;
export function float16Bits(value: number): number;
export function complete<Output>(steps: Iterator<unknown, Output, undefined>): Output;
export function part<Output, Reply>(steps: Generator<number, Output, Reply>, index: number, count: number): Generator<number, Output, Reply>;

export interface PrefixCode {
  alphabetSize: number;
  lengths: Uint8Array<ArrayBuffer>;
  codes: Uint16Array<ArrayBuffer>;
  simple: number[] | null;
  treeSelect: number;
}
export interface UintConfig { split: number; msb: number; lsb: number; splitToken: number; }
export interface PrefixHistogram { config: UintConfig; code: PrefixCode; }
export interface LZ77Config { minSymbol: number; minLength: number; lengthConfig: UintConfig; }
export interface Histograms {
  contextMap: Numbers;
  histograms: readonly PrefixHistogram[];
  lz77?: LZ77Config | null;
}
export function codeLengths(freqs: Numbers, limit: number): Uint8Array<ArrayBuffer>;
export function canonicalCodes(lengths: Numbers): Uint16Array<ArrayBuffer>;
export function buildCode(freqs: Numbers): PrefixCode;
export function writePrefixCode(w: BitWriter, code: PrefixCode): void;
export function uintConfig(split: number, msb?: number, lsb?: number): UintConfig;
export function writeUintConfig(w: BitWriter, config: UintConfig, logAlphabetSize?: number): void;
export function hybridToken(config: UintConfig, value: number, out: { [index: number]: number }): void;
export function countToken(config: UintConfig, value: number, freqs: Uint32Array, base?: number): void;
export function writeHybrid(w: BitWriter, code: PrefixCode, config: UintConfig, value: number, base?: number): void;
export function writeContextMap(w: BitWriter, contextMap: Numbers): void;
export function writeHistograms(w: BitWriter, bundle: Histograms): void;

export const GROUP_DIM: 256;
export const DC_GROUP_DIM: 2048;
export interface ImageHeaderOptions {
  xyb?: boolean; orientation?: Orientation; colorSpace?: ColorSpace;
  bitDepth?: number; exponentBits?: number; transferFunction?: TransferFunction;
  intensityTarget?: number; alphaPremultiplied?: boolean;
}
export interface GroupLayout { groupsX: number; groupsY: number; dcGroupsX: number; dcGroupsY: number; single: boolean; }
export function writeImageHeader(w: BitWriter, width: number, height: number, colour: 1 | 3, alpha: boolean, options?: ImageHeaderOptions): void;
export function writeModularFrameHeader(w: BitWriter, options: {alpha?: boolean; shift?: number}): void;
export function writeFrameHeaderEnd(w: BitWriter, alpha: boolean): void;
export function writeTOC(w: BitWriter, sizes: Numbers): void;
export function groupLayout(width: number, height: number, dim?: number): GroupLayout;
export function finishSections(writers: readonly (BitWriter | null | undefined)[]): Bytes[];
export function assembleCodestream(header: BitWriter, sections: readonly Uint8Array[]): Bytes;

export const PREDICTOR: Readonly<{
  zero: 0; left: 1; top: 2; average0: 3; select: 4; gradient: 5; weighted: 6;
  topRight: 7; topLeft: 8; leftLeft: 9; average1: 10; average2: 11; average3: 12; average4: 13;
}>;
export const LZ77: Readonly<LZ77Config>;
export const RESIDUAL_CONFIG: UintConfig;
export const ALPHABET: 257;
export interface Leaf { predictor: number; offset: number; multiplier: number; context: number; config?: UintConfig; }
export type Tree<L extends Leaf = Leaf> = L | {property: number; splitval: number; left: Tree<L>; right: Tree<L>};
export interface SqueezeParam { horizontal: boolean; inPlace: boolean; beginC: number; numC: number; }
export type Transform =
  | {type: 'rct'; beginC: number; rctType?: number}
  | {type: 'palette'; beginC: number; numC: number; nbColors: number; nbDeltas?: number; predictor?: number}
  | {type: 'squeeze'; params?: readonly SqueezeParam[]};
export function leaf(predictor: number, offset?: number, multiplier?: number): Leaf;
export function split<L extends Leaf>(property: number, splitval: number, left: Tree<L>, right: Tree<L>): Tree<L>;
export function channelTree<L extends Leaf>(leaves: readonly L[]): Tree<L>;
export function streamTree<L extends Leaf>(sections: readonly {streamId: number; tree: Tree<L>}[]): Tree<L>;
/** Assigns each leaf's context in decoder order and returns the same leaves. */
export function writeTree<L extends Leaf>(w: BitWriter, root: Tree<L>): L[];
export function writeTransform(w: BitWriter, transform: Transform): void;
export function writeModularHeader(w: BitWriter, options?: {useGlobalTree?: boolean; transforms?: readonly Transform[]}): void;
export function writeChannelHistograms<L extends Leaf>(w: BitWriter, orderedLeaves: readonly L[], freqs: readonly Uint32Array[], histogramOf?: (leaf: L) => number, configOf?: (index: number) => UintConfig): PrefixHistogram[];
/** With a null writer, count residual tokens; otherwise write them through the supplied prefix code. */
export function codeChannel(w: null, target: Uint32Array, plane: Plane, width: number, height: number, leaf: Leaf, raw?: boolean): void;
export function codeChannel(w: BitWriter, target: PrefixCode, plane: Plane, width: number, height: number, leaf: Leaf, raw?: false): void;

export const WEIGHTED_PREDICTOR: 6;
export const WEIGHTED_PROPERTY: 15;
export const WEIGHTED_CUTS: number[];
export function codeWeighted(w: null, targets: readonly Uint32Array[], plane: Plane, width: number, height: number, offset?: number, contextOf?: Numbers, residuals?: Uint32Array, properties?: Int32Array): void;
export function codeWeighted(w: BitWriter, targets: readonly PrefixCode[], plane: Plane, width: number, height: number, offset?: number, contextOf?: Numbers, residuals?: Uint32Array, properties?: Int32Array): void;
/** Supplying residuals records the predictor output without counting or writing tokens. */
export function codeWeighted(w: null, targets: null, plane: Plane, width: number, height: number, offset: number | undefined, contextOf: Numbers | undefined, residuals: Uint32Array, properties?: Int32Array): void;

export interface SqueezeChannel { w: number; h: number; hshift: number; vshift: number; data: Int16Array; component?: number; }
export interface SqueezedChannel extends SqueezeChannel { level: number; residual: boolean; }
export function defaultSqueezeParams(channels: readonly Pick<SqueezeChannel, 'w' | 'h'>[]): SqueezeParam[];
export function forwardSqueeze(channels: readonly SqueezeChannel[], params?: readonly SqueezeParam[]): SqueezedChannel[];
export interface PixelShape<Key extends number | string = number> {
  colour: 1 | 3;
  alpha: boolean;
  channels: number;
  palette: {colours: Key[]; byte: (colour: Key, channel: number) => number} | null;
}
export interface LosslessOptions extends EncodeOptions { shape?: PixelShape | PixelShape<string>; }
export interface LossyOptions extends LosslessOptions { quality?: number; }
export function inspectPixels(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, options?: EncodeOptions & {palette?: boolean}): PixelShape;
export function inspectPixels(rgba: Uint16Array | Float32Array, width: number, height: number, options?: EncodeOptions & {palette?: boolean}): PixelShape<string>;
export function inspectPixels(rgba: Pixels, width: number, height: number, options?: EncodeOptions & {palette?: boolean}): PixelShape | PixelShape<string>;
export function encodeLossless(rgba: Pixels, width: number, height: number, options?: LosslessOptions): Bytes;
export function losslessSteps(rgba: Pixels, width: number, height: number, options?: LosslessOptions): Steps;
export function distanceFromQuality(quality: number): number;
export function quantiserFor(component: number, hshift: number, vshift: number, distance: number): number;
export function encodeLossy(rgba: Pixels, width: number, height: number, options?: LossyOptions): Bytes;
export function lossySteps(rgba: Pixels, width: number, height: number, options?: LossyOptions): Steps;

export class TokenCounts {
  constructor(contexts: number);
  contexts: number;
  small: Uint32Array<ArrayBuffer>;
  large: (Map<number, number> | null)[];
  totals: Float64Array<ArrayBuffer>;
  add(context: number, value: number): void;
  tokens(contexts: Iterable<number>, config: UintConfig, size?: number): Uint32Array<ArrayBuffer>;
  cost(contexts: Iterable<number>, config: UintConfig): number;
}
export interface ClusterOptions { maxClusters?: number; newClusterCost?: number; }
export interface TokenCoding {
  contextMap: Uint8Array<ArrayBuffer>;
  histograms: PrefixHistogram[];
  bits: number;
  write(w: BitWriter, context: number, value: number): void;
}
export function buildTokenCoding(counts: TokenCounts, options?: ClusterOptions): TokenCoding;

export interface DCTComponent { h: number; v: number; stride: number; rows: number; quant: Int32Array; coeffs: Int16Array; }
export interface CoefficientImage {
  width: number;
  height: number;
  components: readonly DCTComponent[];
  ycbcr?: boolean;
  orientation?: Orientation;
  colorSpace?: ColorSpace;
  alpha?: Pixels | null;
  quantScale?: number;
  quantFieldBase?: number;
  quantFields?: Uint8Array;
}
export type CoefficientCoding = {
  bits: number;
  write(w: BitWriter, context: number, value: number): void;
  flush?(w: BitWriter): void;
} & (
  | {contextMap: Numbers; histograms: readonly PrefixHistogram[]; writeHistograms?: (w: BitWriter) => void}
  | {writeHistograms(w: BitWriter): void; contextMap?: Numbers; histograms?: readonly PrefixHistogram[]}
);
export interface VarDCTPlan {
  orders?: readonly (readonly number[])[];
  clusters?: ClusterOptions;
  coding?: (counts: TokenCounts, options?: ClusterOptions) => CoefficientCoding;
}
export interface JPEGComponent extends DCTComponent { id: number; tq: number; pred: number; coverage: Int8Array; blocksW: number; blocksH: number; }
export interface ParsedJPEG extends CoefficientImage { components: JPEGComponent[]; progressive: boolean; ycbcr: boolean; orientation: Orientation; colorSpace: ColorSpace; }
export function encodeVarDCT(jpeg: CoefficientImage, plan?: VarDCTPlan): Bytes;
export function varDCTSteps(jpeg: CoefficientImage, plan?: VarDCTPlan): Steps;
export function transcodeJPEG(bytes: Uint8Array, jpeg?: CoefficientImage): Bytes;
export function parseJPEG(bytes: Uint8Array): ParsedJPEG;
export function profileSpace(profile: Uint8Array): ColorSpace | null;
export const ZIGZAG: number[];

export function fault(code: ErrorCode, message: string): EncoderError;
export function admitOptions(options?: EncodeOptions, quality?: number): Required<Pick<EncodeOptions, 'quality' | 'colorSpace'>>;
export function admitSize(width: number, height: number, limits?: Limits): void;
export function admitPixels(data: unknown, width: number, height: number, limits?: Limits): asserts data is Pixels;
export function answer<Output extends Uint8Array>(bytes: Output): Output;
export function guard<Output>(work: () => Output): Output;
export function job<Output extends Uint8Array>(steps: Generator<number, Output, boolean | undefined>): Job<Output>;
