import type {AnimationInput, CaptureRect, ErrorCode, ImageInput, JobOptions, ReadAs, PackageDecode, JpegRestore} from './types.mjs';
import type {Digest, ImageResult, ResultSource, ResultTransform} from './result.mjs';
import type {WasmBundle} from './wasm.mjs';

/** Install the package's precompiled kernels before verification in a restricted WebAssembly host. */
export function configureWasm(bundle: WasmBundle): void;
/** In a browser, verify reads 8-bit sRGB and Display P3 stills with the browser's own JPEG XL decode, and Node, Deno and
 * Bun need nothing. Elsewhere, and for recompressed JPEGs, row sources, animations, more than 8 bits, float samples or
 * other color, the one setup step is `configureDecoder(decode, restore)` with rapier-jxl/decode's decode and
 * rapier-jxl/jpeg's restore; without it those refuse JXL_UNSUPPORTED. One call serves every rapier-jxl module. */
export function configureDecoder(decode: PackageDecode | null, restore?: JpegRestore | null): void;

/** Explicit exact-pixel obligations in output-canvas coordinates, snapshotted at verify().
 * Applies to an unrotated still raster, including a transformed still reference.
 * Supply the actual selected mask for conditional text or edge protection; hints are not masks. */
export interface VerifyProtection {
  /** Unconditional full rectangles. Negative/off-canvas coordinates are clipped; overlapping pixels count once. */
  readonly exactRects?: ReadonlyArray<CaptureRect & {solidText?: never; edge?: never}>;
  /** One binary byte per output pixel, 1 = exact. The selection unions with exactRects. */
  readonly mask?: Uint8Array;
}
export type VerifyOptions = Pick<JobOptions, 'signal' | 'onProgress' | 'maxPixels'> & {protection?: VerifyProtection};
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
  /** Proves only the supplied selection; its completeness is the caller's separate obligation. */
  readonly protection?: ProtectionEvidence;
  readonly metric?: 'ssimulacra2' | 'butteraugli' | 'butteraugli3' | 'max-error';
  readonly score?: number;
  /** The record's measurements this verification did not measure (another metric, or a region): not vouched for. */
  readonly unchecked?: readonly {readonly metric: 'ssimulacra2' | 'butteraugli' | 'butteraugli3' | 'max-error'; readonly region?: {readonly x: number; readonly y: number; readonly width: number; readonly height: number}}[];
  readonly floor?: number;
  readonly limit?: number;
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
export interface VerificationError extends Error {
  readonly code: ErrorCode;
  readonly verification?: FailedVerificationReceipt;
}
/** Restore and compare a JPEG, compare exact decoded samples, or measure the decoded lossy output against its
 * declared target, plus every explicitly protected sample. Rejects with an existing JXL_* code;
 * a failed comparison includes error.verification.
 * The original and result are snapshotted at the call. This module never writes, replaces, or deletes a file. */
// The original is any Uint8Array a caller holds (a view on any buffer), samples or an animation.
export function verify(original: ImageInput | AnimationInput | Uint8Array, output: ImageResult, options?: VerifyOptions): Promise<VerificationReceipt>;
