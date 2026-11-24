import type {AnimationInput, CaptureRect, EncodedInput, ErrorCode, ImageInput, JobOptions, ReadAs, PackageDecode, JpegRestore, JpegRecompress} from './types.mjs';
export type {EncodedInput};
import type {Digest, ImageResult, ResultOtherDecoders, ResultSource, ResultTransform} from './result.mjs';

/** In a browser, direct verify() reads 8-bit sRGB and Display P3 stills with the browser's own JPEG XL decode, and direct
 * verify() in Node, Deno and Bun needs nothing. Resumable verification (jpegxl/resumable with verify), and elsewhere
 * for recompressed JPEGs, row sources, animations, more than 8 bits, float samples or
 * other color, the one setup step is `configureDecoder(decode, restore)` with jpegxl/decode's decode and
 * jpegxl/jpeg's restore. Without it those refuse JXL_PLATFORM, naming it. One call serves every jpegxl module.
 * @example configureDecoder((await import('jpegxl/decode')).decode, (await import('jpegxl/jpeg')).restore); */
export function configureDecoder(decode: PackageDecode | null, restore?: JpegRestore | null, recompress?: JpegRecompress | null): void;

/** Explicit exact-pixel obligations in output-canvas coordinates, snapshotted at verify().
 * Applies to an unrotated still raster, including a transformed still reference.
 * Supply the actual selected mask for conditional text or edge protection. Hints are not masks. */
export interface VerifyProtection {
  /** Unconditional full rectangles. Negative/off-canvas coordinates are clipped. Overlapping pixels count once. */
  readonly exactRects?: ReadonlyArray<CaptureRect & {solidText?: never; edge?: never}>;
  /** One binary byte per output pixel, 1 = exact. The selection unions with exactRects. */
  readonly mask?: Uint8Array;
}
export type VerifyOptions = Pick<JobOptions, 'signal' | 'onProgress' | 'maxPixels'> & {
  /** Pixels that must decode exactly, whatever the output's fidelity. */
  protection?: VerifyProtection};
export interface ProtectionEvidence {
  /** SHA-256 of the canonical output dimensions and selected pixel set. */
  readonly digest: Digest;
  readonly pixels: number;
  /** Every selected decoded RGBA sample equals its reference. */
  readonly exact: boolean;
}
interface VerificationDetails {
  readonly source: ResultSource | null;
  readonly outputDigest: Digest;
  readonly referenceDigest?: Digest;
  readonly restoredDigest?: Digest;
  readonly width: number;
  readonly height: number;
  readonly format: 'jxl' | 'jpeg' | 'png';
  readonly kept: 'jpeg-bytes' | 'pixels' | 'lossy';
  readonly fidelity: ImageResult['fidelity'];
  readonly transform?: ResultTransform;
  readonly readAs?: ReadAs;
  /** A JPEG restore whose last bytes another decoder does not return, measured on the file. */
  readonly otherDecoders?: ResultOtherDecoders;
  /** Proves only the supplied selection. Its completeness is the caller's separate obligation. */
  readonly protection?: ProtectionEvidence;
  readonly metric?: 'ssimulacra2' | 'max-error';
  readonly score?: number;
  /** An SSIMULACRA 2 score is libjxl's definition read as binary64 would read it (within 0.00001), not libjxl
   * 0.12's binary32 tool, which reads smooth, bright and large pictures up to several points lower. */
  readonly arithmetic?: 'binary64';
  /** The same file read by libjxl 0.12's binary32 arithmetic: what libjxl's `ssimulacra2` tool prints for it. */
  readonly libjxlScore?: number;
  /** The record's measurements this verification did not measure (another metric, or a region): not vouched for. */
  readonly unchecked?: readonly {readonly metric: 'ssimulacra2' | 'max-error'; readonly region?: {readonly x: number; readonly y: number; readonly width: number; readonly height: number}}[];
  /** 'without-noise': the record's look was searched with the noise off, and `score` is the file's noise-off reading
   * (jpegxl/decode's alone gives it). 'pu21': a high dynamic range file read through PU21. */
  readonly view?: 'pu21' | 'without-noise';
  /** Beside a noise-off reading: the decoded reading, what every decoder shows. */
  readonly decodedScore?: number;
  /** 'noise': the record's look was searched with the noise off and only another decoder was here: that look is not
   * checked. The file verifies only where its decoded reading, noise and all, meets the floor. */
  readonly notChecked?: 'noise';
  readonly floor?: number;
  readonly limit?: number;
  /** 'opaque': colour was compared only where alpha is 255 (alpha everywhere). This browser hands its decode back
   * premultiplied and no decoder was configured. configureDecoder(decode, restore) compares every sample. */
  readonly colorScope?: 'opaque';
  readonly domain?: 'decoded-output';
  /** A quality predictor is a declared score target, not a same-picture WebP comparison. */
  readonly targetOrigin?: 'explicit' | 'quality-prediction';
}
/** Independent evidence bound to the original and the actual output file. */
export interface VerificationReceipt extends VerificationDetails {
  readonly source: ResultSource;
  readonly verified: true;
  readonly protection?: ProtectionEvidence & {readonly exact: true};
  readonly kind: 'jpeg-restore' | 'pixels' | 'score' | 'max-error';
}
/** Available on a failed comparison when the original and output were admitted. */
export interface FailedVerificationReceipt extends VerificationDetails {
  readonly verified: false;
  readonly kind?: VerificationReceipt['kind'];
  readonly reason: {readonly code: ErrorCode; readonly message: string};
}
/** What verify rejects with: a JXL_ code, and the failed receipt when the comparison ran. */
export interface VerificationError extends Error {
  readonly code: ErrorCode;
  readonly verification?: FailedVerificationReceipt;
}
/** Restore and compare a JPEG, compare exact decoded samples, or measure the decoded lossy output against its
 * declared target, plus every explicitly protected sample. Rejects with an existing JXL_* code.
 * A failed comparison includes error.verification.
 * The original and result are snapshotted at the call. This module never writes, replaces, or deletes a file.
 * Invalid protection refuses JXL_OPTIONS. Incompatible JPEG verification refuses JXL_UNSUPPORTED. Missing JPEG reconstruction refuses JXL_RECONSTRUCTION. */
// The original is an attached ArrayBuffer or view, samples or an animation. Shared storage is refused.
/** @example const receipt = await verify(pixels, result); */
export function verify(original: ImageInput | AnimationInput | EncodedInput, output: ImageResult, options?: VerifyOptions): Promise<VerificationReceipt>;

/** Codes for refusals raised by rapier-jxl. Caller callback errors and abort reasons pass through unchanged. */
export type {CodecError, ErrorCode} from './types.mjs';
