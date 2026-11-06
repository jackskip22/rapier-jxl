import type {capture} from './capture.mjs';
import type {recompress, restore} from './jpeg.mjs';
import type * as root from './index.mjs';
import type * as upload from './upload.mjs';
import type {Bytes, CaptureOptions, JPEGOptions, JobOptions, Pixels} from './types.mjs';

type Awaitable<T> = T | PromiseLike<T>;

declare const operationSteps: unique symbol;
/** A callable carrying its own resumable steps. The private marker exists only in the type system. */
export type ResumableFunction<Call extends (...args: never[]) => unknown> = Call & {readonly [operationSteps]: unknown};

/** The immutable original held by the store. generation is a nonempty host identifier (at most 256 characters),
 * and sha256 is the original bytes' SHA-256 as 64 lowercase hexadecimal characters, without a prefix.
 * JPEG operations read file bytes; capture reads straight RGBA8 rows described by ResumablePixels; encode, fit and
 * variants read either, an encoded file named by kind 'file' (ResumableFile). */
export interface ResumableInput {
  readonly generation: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly kind?: 'pixels' | 'file';
  readonly width?: number;
  readonly height?: number;
  /** Defaults to sRGB. */
  readonly colorSpace?: Pixels['colorSpace'];
}

/** Straight RGBA8 rows: positive pixel dimensions; byteLength is width * height * 4. */
export interface ResumablePixels extends ResumableInput {
  readonly kind?: 'pixels';
  readonly width: number;
  readonly height: number;
}
/** An encoded file (JPEG, PNG, WebP and the others an upload reads), read in the job's own steps. */
export interface ResumableFile extends ResumableInput {
  readonly kind: 'file';
}

/** An immutable stored part, at most 1 MiB. hash is its SHA-256 as 64 lowercase hexadecimal characters. */
export interface PartRef {
  readonly hash: string;
  readonly length: number;
}

/** Keep every part until the job no longer needs its checkpoint. Writes are idempotent and finish persisting
 * before they resolve. A call awaits its writes before returning the checkpoint the host saves. Reads return
 * the exact requested byte range or part; a readMany result follows its references' order. */
interface StoreReads {
  readSource(offset: number, length: number): Awaitable<Uint8Array>;
  read(ref: PartRef): Awaitable<Uint8Array>;
  readMany?(refs: readonly PartRef[]): Awaitable<readonly Uint8Array[]>;
}
/** write keeps one part; writeMany keeps a call's parts in one request. A store has either, or both. */
export type ResumableStore = StoreReads & (
  {write(ref: PartRef, bytes: Bytes): Awaitable<void>; writeMany?(parts: readonly {readonly ref: PartRef; readonly bytes: Bytes}[]): Awaitable<void>} |
  {write?(ref: PartRef, bytes: Bytes): Awaitable<void>; writeMany(parts: readonly {readonly ref: PartRef; readonly bytes: Bytes}[]): Awaitable<void>});

declare const checkpointBrand: unique symbol;
/** An opaque JSON record returned by start or advance. Persist it unchanged after the call's writes finish,
 * using revision to guard the host's save, and pass the latest saved record to the next call. The driver
 * rejects stale, changed or foreign records. The brand exists only in the type system. */
export interface Checkpoint {
  readonly revision: number;
  readonly [checkpointBrand]: true;
}

type Uploads = typeof root.encode | typeof root.fit | typeof root.variants | typeof upload.encode | typeof upload.fit | typeof upload.variants;
/** Resumable verbs: encode/fit/variants from rapier-jxl or rapier-jxl/upload, capture from rapier-jxl/capture, and recompress/restore from rapier-jxl/jpeg. */
export type ResumableOperation = typeof capture | typeof recompress | typeof restore | Uploads;

type OptionKeys = keyof CaptureOptions | keyof JPEGOptions;
type SavedOptions<Options, Keys extends keyof Options> = Readonly<Pick<Options, Keys>> & {
  readonly [K in Exclude<OptionKeys, Keys>]?: never;
};
/** Capture's data-only saved options. Per-call cancellation is supplied to advance or finish. */
export type ResumableCaptureOptions = SavedOptions<CaptureOptions, 'fidelity' | 'effort' | 'webgpu'>;
/** Recompression preserves the JPEG's coefficients and takes these ordinary JPEG settings. */
export type ResumableJPEGOptions = SavedOptions<JPEGOptions, 'effort' | 'icc' | 'maxPixels'>;
/** Restoration admits only the pixel bound in its saved plan. */
export type ResumableRestoreOptions = SavedOptions<JobOptions, 'maxPixels'>;
type Saved<Options, Keys extends PropertyKey> = Options extends unknown ? Readonly<Pick<Options, Extract<Keys, keyof Options>>> & {
  readonly [K in Exclude<keyof Options, Keys>]?: never;
} : never;
/** encode, fit and variants save their data options: callbacks, signals and helpers belong to each call. */
export type ResumableUploadOptions<Operation extends Uploads> =
  Saved<NonNullable<Parameters<Operation>[1]>, 'fidelity' | 'effort' | 'readAs' | 'maxPixels' | 'features' | 'webgpu' | 'maxBytes' | 'outputs'>;

type OptionsOf<Operation extends ResumableOperation> = NonNullable<Parameters<Operation>[1]>;
export type ResumableOptions<Operation extends ResumableOperation> = Operation extends unknown
  ? Operation extends Uploads ? ResumableUploadOptions<Operation>
  : 'fidelity' extends keyof OptionsOf<Operation> ? ResumableCaptureOptions
  : 'icc' extends keyof OptionsOf<Operation> ? ResumableJPEGOptions
  : ResumableRestoreOptions
  : never;
type InputOf<Operation extends ResumableOperation> = Operation extends unknown
  ? Operation extends Uploads ? ResumablePixels | ResumableFile
  : 'fidelity' extends keyof OptionsOf<Operation> ? ResumablePixels & {readonly colorSpace?: 'srgb' | 'display-p3'} : ResumableInput
  : never;

interface OperationContext<Operation extends ResumableOperation = ResumableOperation> {
  /** Pass the imported verb itself: capture, recompress, restore, encode, fit or variants. */
  readonly operation: Operation;
  readonly store: ResumableStore;
}
/** The operation alone determines the admitted source and option shapes. */
export type StartOptions<Operation extends ResumableOperation = ResumableOperation> = Operation extends unknown ? OperationContext<Operation> & {
  readonly input: InputOf<NoInfer<Operation>>;
} & (undefined extends Parameters<NoInfer<Operation>>[1]
  ? {readonly options?: ResumableOptions<NoInfer<Operation>>}
  : {readonly options: ResumableOptions<NoInfer<Operation>>}) : never;
export interface FinishOptions<Operation extends ResumableOperation = ResumableOperation> extends OperationContext<Operation> {
  /** The input start was given, the same descriptor: a checkpoint of another original is refused. */
  readonly input: ResumableInput;
  readonly signal?: AbortSignal;
}
export interface AdvanceOptions extends FinishOptions {
  /** Positive milliseconds, at most 60000; defaults to {ms: 30}. A call advances at least one step. */
  readonly budget?: {readonly ms: number};
}
export interface AdvanceResult {
  readonly checkpoint: Checkpoint;
  readonly done: boolean;
}

/** Start the operation over the stored original and return its first durable checkpoint. */
export function start<Operation extends ResumableOperation>(options: OperationContext<Operation> & StartOptions<Operation>): Promise<Checkpoint>;
/** Advance the latest checkpoint within this call's budget, awaiting every new part's write. */
export function advance(checkpoint: Checkpoint, options: AdvanceOptions): Promise<AdvanceResult>;
/** Assemble a finished checkpoint's output and return what the ordinary operation returns: its result record, or
 * variants' list of them. */
export function finish<Operation extends ResumableOperation>(checkpoint: Checkpoint, options: FinishOptions<Operation>): Promise<Awaited<ReturnType<Operation>>>;

export {};
