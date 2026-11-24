import type {Bytes, EncodeOptions, ErrorCode, Fidelity, FitFidelity, FitOptions, JobOptions, ReadAs, VariantsOptions} from './types.mjs';
import type {CaptureCompleteOptions} from './capture-complete.mjs';
import type {RecompressOptions} from './jpeg.mjs';

/** An ordinary image operation. The original is supplied separately to the chosen execution host. */
export type ImageJob =
  | {readonly verb: 'encode'; readonly options?: EncodeOptions}
  | {readonly verb: 'capture'; readonly options?: CaptureCompleteOptions}
  | {readonly verb: 'fit'; readonly options: FitOptions}
  | {readonly verb: 'variants'; readonly options: VariantsOptions}
  | {readonly verb: 'recompress'; readonly options?: RecompressOptions}
  | {readonly verb: 'restore'; readonly options?: JobOptions};
/** The call that made a result: encode, fit, variants, capture, recompress, restore or another verb. */
export type ImageVerb = ImageJob['verb'];

/** A result retains the requested fitting range when no file meets the byte target. Result error bounds may be
 * fractional finite nonnegative values (for example, decoded PNG samples). Capture inputs keep their integer bounds. */
type OutputFidelity = Fidelity | ({readonly maxError: number} &
  {readonly [K in 'quality' | 'ssimulacra2']?: never});
/** The fidelity the file was made at, or for a fit the range it was searched in. */
export type ResultFidelity = OutputFidelity | FitFidelity;

/** SHA-256 of the identified bytes or canonical sample description and pixels. */
export type Digest = `sha256:${string}`;
/** What the result was made from: bytes or pixels, and the SHA-256 of them. */
export interface ResultSource {
  readonly kind: 'bytes' | 'pixels';
  readonly digest: Digest;
}
/** A requested target could not be met. Codes keep their ordinary meanings. */
export interface ResultReason {
  readonly code: ErrorCode;
  readonly message: string;
}
/** The transform applied to the original for this output: our area average in linear light to width and height. */
export interface ResultTransform {readonly width: number; readonly height: number; readonly frame?: number;}
/** Measurements already made by the encoder, or attached by an independent verifier. The domain names
 * what was measured. 'predicted' is not a measurement: the target a lossy effort 1-5 file aimed at, as its floor, with no
 * score (no meter ran), at every depth and quality. A lower bound uses floor and an upper bound uses limit. Explicit S2 targets at efforts 1–5
 * report a guarded reconstruction score: a lower bound for the browser-decoded picture. */
export type ResultMeasurement = ({
  readonly score: number;
  readonly domain: 'encoder-reconstruction' | 'decoded-output';
  /** Absent: the picture as it is, 8-bit sRGB. 'pu21': a high dynamic range picture seen through PU21 (203 cd/m2 is white, light above it counts), scored by the same SSIMULACRA 2. 'without-noise': the file as coded before the noise it was asked to carry was added. */
  readonly view?: 'pu21' | 'without-noise';
  readonly region?: {readonly x: number; readonly y: number; readonly width: number; readonly height: number};
} & (
  {readonly metric: 'ssimulacra2'; readonly floor?: number; readonly limit?: never} |
  {readonly metric: 'max-error'; readonly limit?: number; readonly floor?: never}
)) |
  /** Efforts 1-5 measure nothing: the SSIMULACRA 2 target the file aimed at, at every depth and quality ('pu21' for HDR). */
  {readonly metric: 'ssimulacra2'; readonly domain: 'predicted'; readonly floor: number; readonly view?: 'pu21' | 'without-noise'; readonly score?: never; readonly limit?: never; readonly region?: never};
interface ResultDescription<F = ResultFidelity> {
  readonly width: number;
  readonly height: number;
  /** The file's format: 'jxl', or 'jpeg' for a restored JPEG, or 'png'. */
  readonly format: 'jxl' | 'jpeg' | 'png';
  /** A canonical execution identity when already supplied. Ordinary calls do not hash their input. */
  readonly source: ResultSource | null;
  readonly fidelity: F;
  readonly measurements: readonly ResultMeasurement[];
  readonly transform?: ResultTransform;
  readonly readAs?: ReadAs;
  /** Original encoded input size when known, retained even when no output file meets the target. */
  readonly originalBytes?: number;
  /** True exactly when the returned file exceeds originalBytes. Omitted when no file was returned. */
  readonly largerThanOriginal?: boolean;
  /** Present on an exact JPEG result when another decoder returns less than the whole JPEG: with an Ultra HDR gain map
   * in jhgm (the default), djxl and other decoders restore the primary JPEG alone, and restore returns the whole file. */
  readonly otherDecoders?: ResultOtherDecoders;
  /** An animation's durations: 'rounded' when one was rounded to the file's tick (each frame still ends within half a tick). */
  readonly timing?: 'exact' | 'rounded';
  /** A capture: 'skipped' where the page held more marks of ink than the reader takes. The caller's boxes and the
   * repeated marks stayed exact, and unboxed text was not looked for. */
  readonly textMarks?: 'skipped';
  /** An animation: the frames (each its first input frame) that needed a final quality-floor repair, and what was done:
   * 'raised' (coded at the top lossy quality and read over it) or 'exact file' (the animation's exact file returned). */
  readonly unproved?: readonly {readonly frame: number; readonly done: 'raised' | 'exact file'}[];
  /** From the entries that can run stages on WebGPU (jpegxl's encode, fit and variants, animation, format's encode,
   * capture-complete): true when a stage of this call ran on the device. The file is the same either way. */
  readonly usedWebGPU?: boolean;
}
/** Another decoder (libjxl's djxl) returns this JPEG without its last `missing` bytes. Jpegxl/jpeg's restore returns
 * all of it. 'past-jbrd': data after the JPEG's end travels outside the reconstruction box. This happens for tails
 * longer than the 4,260,096 bytes the box holds, or when an Ultra HDR gain map is kept in a jhgm bundle. */
export interface ResultOtherDecoders {
  readonly missing: number;
  readonly reason: 'past-jbrd';
}
/** A result that always holds a file: what encode, capture, recompress, restore, format and animation's encode resolve with. */
export type EncodedResult = ResultDescription<OutputFidelity> & (
  {readonly bytes: Bytes; readonly kept: 'jpeg-bytes' | 'pixels' | 'lossy';
   readonly meetsTarget: true; readonly reason?: never} |
  {readonly bytes: Bytes; readonly kept: 'jpeg-bytes' | 'pixels' | 'lossy';
   readonly meetsTarget: false; readonly reason: ResultReason}
);
/** One record per requested output, shared by ordinary calls and queues. Only fit and variants can resolve without a file. A preserved JPEG has kept: 'jpeg-bytes',
 * fidelity: 'exact' and measurements: []: the original JPEG restores exactly, with no claim of a measured score.
 * Empty measurements add no independent verification claim. An encode can return meetsTarget: false with bytes when its
 * measured look target was missed. An unmet size target (fit, variants) returns meetsTarget: false without a file. */
export type ImageResult = EncodedResult | (ResultDescription &
  {readonly bytes: null; readonly kept: null; readonly meetsTarget: false;
   readonly reason: ResultReason & {readonly code: 'JXL_TARGET'}}
);
