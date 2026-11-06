import type {Bytes, EncodeOptions, ErrorCode, Fidelity, FitFidelity, FitOptions, JPEGOptions, JobOptions, ReadAs, VariantsOptions} from './types.mjs';
import type {CaptureCompleteOptions} from './capture-complete.mjs';

/** An ordinary image operation. The original is supplied separately to the chosen execution host. */
export type ImageJob =
  | {readonly verb: 'encode'; readonly options?: EncodeOptions}
  | {readonly verb: 'capture'; readonly options?: CaptureCompleteOptions}
  | {readonly verb: 'fit'; readonly options: FitOptions}
  | {readonly verb: 'variants'; readonly options: VariantsOptions}
  | {readonly verb: 'recompress'; readonly options?: JPEGOptions}
  | {readonly verb: 'restore'; readonly options?: JobOptions};
export type ImageVerb = ImageJob['verb'];

/** A result retains the requested fitting range when no file meets the byte target. Result error bounds may be
 * fractional finite nonnegative values (for example, decoded PNG samples); capture inputs keep their integer bounds. */
type OutputFidelity = Fidelity | ({readonly maxError: number} &
  {readonly [K in 'quality' | 'ssimulacra2' | 'butteraugli' | 'butteraugli3']?: never});
export type ResultFidelity = OutputFidelity | FitFidelity;

/** SHA-256 of the identified bytes or canonical sample description and pixels. */
export type Digest = `sha256:${string}`;
export interface ResultSource {
  readonly kind: 'bytes' | 'pixels';
  readonly digest: Digest;
}
/** A requested target could not be met. Codes keep their ordinary meanings. */
export interface ResultReason {
  readonly code: ErrorCode;
  readonly message: string;
}
/** The transform applied to the original for this output. */
export interface ResultTransform {readonly width: number; readonly height: number; readonly frame?: number;}
/** Measurements already made by the encoder, or attached by an independent verifier. The domain names
 * what was measured. A lower bound uses floor and an upper bound uses limit. */
export type ResultMeasurement = {
  readonly score: number;
  readonly domain: 'encoder-reconstruction' | 'decoded-output';
  readonly region?: {readonly x: number; readonly y: number; readonly width: number; readonly height: number};
} & (
  {readonly metric: 'ssimulacra2'; readonly floor?: number; readonly limit?: never} |
  {readonly metric: 'butteraugli' | 'butteraugli3' | 'max-error'; readonly limit?: number; readonly floor?: never}
);
interface ResultDescription<F = ResultFidelity> {
  readonly width: number;
  readonly height: number;
  readonly format: 'jxl' | 'jpeg' | 'png';
  /** A canonical execution identity when already supplied; ordinary calls do not hash their input. */
  readonly source: ResultSource | null;
  readonly fidelity: F;
  readonly measurements: readonly ResultMeasurement[];
  readonly transform?: ResultTransform;
  readonly readAs?: ReadAs;
}
/** One record per requested output, shared by ordinary calls and queues. kept is the encoder's preservation
 * promise. Empty measurements add no independent verification claim. An unmet size target carries no oversized file. */
export type ImageResult = (ResultDescription<OutputFidelity> & (
  {readonly bytes: Bytes; readonly kept: 'jpeg-bytes' | 'pixels' | 'lossy';
   readonly fits: true; readonly reason?: never} |
  {readonly bytes: Bytes; readonly kept: 'jpeg-bytes' | 'pixels' | 'lossy';
   readonly fits: false; readonly reason: ResultReason}
)) | (ResultDescription &
  {readonly bytes: null; readonly kept: null; readonly fits: false;
   readonly reason: ResultReason & {readonly code: 'JXL_TARGET'}}
);
type Serialized<R extends ImageResult> = R extends unknown ? Omit<R, 'bytes'> & {
  readonly bytes: R['bytes'] extends null ? null : string;
  readonly byteEncoding: 'base64';
} : never;
/** JSON-safe form of the same record; encoded file bytes use base64. */
export type ImageResultJSON = Serialized<ImageResult>;
/** Serialize one result without losing its source identity or measurements. */
export function resultJSON(result: ImageResult): ImageResultJSON;
