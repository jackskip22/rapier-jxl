import type {capture} from './capture.mjs';
import type {capture as captureComplete, CaptureCompleteOptions} from './capture-complete.mjs';
import type {recompress, restore} from './jpeg.mjs';
import type * as root from './index.mjs';
import type * as upload from './upload.mjs';
import type {Bytes, CaptureOptions, JPEGOptions, JobOptions, Pixels} from './types.mjs';
import type {VerificationReceipt} from './verify.mjs';
import type {verify} from './verify.mjs';
import type {ImageResult} from './result.mjs';
import type {WasmBundle} from './wasm.mjs';

/** Install this package's precompiled kernels before resumable verification in a restricted WebAssembly host. */
export function configureWasm(bundle: WasmBundle): void;

type Awaitable<T> = T | PromiseLike<T>;

declare const operationSteps: unique symbol;
/** A callable carrying its own resumable steps. The private marker exists only in the type system. */
export type ResumableFunction<Call extends (...args: never[]) => unknown> = Call & {readonly [operationSteps]: unknown};

/** The immutable original held by the store. generation is a nonempty host identifier (at most 256 characters),
 * and sha256 is the original bytes' SHA-256 as 64 lowercase hexadecimal characters, without a prefix.
 * JPEG operations read file bytes; capture reads straight RGBA8 rows described by ResumablePixels; encode, fit and
 * variants and verify read either, an encoded file named by kind 'file' (ResumableFile); encode and fit also read a JPEG XL
 * whose decode is the picture (ResumableDecode). */
export interface ResumableInput {
  readonly generation: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly kind?: 'pixels' | 'file' | 'decode';
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

/** A stored JPEG XL, such as a JPEG's lossless one, whose picture is its decode: rapier-jxl/decode's decode, set once with
 * configureDecoder(decode) from rapier-jxl/verify. The job encodes the decoded pixels, as encode() of them would. */
export interface ResumableDecode extends ResumableInput {
  readonly kind: 'decode';
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
 * rejects stale, changed or foreign records. Keep checkpoints where only your service writes them; the original and
 * parts may be in any store, and every byte read back is checked. The brand exists only in the type system. */
export interface Checkpoint {
  readonly revision: number;
  readonly [checkpointBrand]: true;
}

type Uploads = typeof root.encode | typeof root.fit | typeof root.variants | typeof upload.encode | typeof upload.fit | typeof upload.variants;
/** Resumable verbs: encode/fit/variants from rapier-jxl or rapier-jxl/upload, capture from rapier-jxl/capture or
 * rapier-jxl/capture-complete (every effort), recompress/restore from rapier-jxl/jpeg, and verify from rapier-jxl/verify. */
export type ResumableOperation = typeof capture | typeof captureComplete | typeof recompress | typeof restore | typeof verify | Uploads;

type OptionKeys = keyof CaptureOptions | keyof JPEGOptions;
type SavedOptions<Options, Keys extends keyof Options> = Readonly<Pick<Options, Keys>> & {
  readonly [K in Exclude<OptionKeys, Keys>]?: never;
};
/** Capture's data-only saved options. Per-call cancellation is supplied to advance or finish. */
export type ResumableCaptureOptions = SavedOptions<CaptureOptions, 'fidelity' | 'effort' | 'webgpu'>;
/** capture-complete's data-only saved options: its rectangles too. */
export type ResumableCaptureCompleteOptions = Saved<CaptureCompleteOptions, 'fidelity' | 'effort' | 'webgpu' | 'exactRects' | 'photoRects' | 'textComplete' | 'maxPixels'>;
/** Recompression preserves the JPEG's coefficients and takes these ordinary JPEG settings. */
export type ResumableJPEGOptions = SavedOptions<JPEGOptions, 'effort' | 'icc' | 'maxPixels'>;
/** Restoration admits only the pixel bound in its saved plan. */
export type ResumableRestoreOptions = SavedOptions<JobOptions, 'maxPixels'>;
type StoredResult<Result> = Result extends {readonly bytes: Bytes} ? Omit<Result, 'bytes'> & {readonly bytes?: never; readonly verification?: never} : never;
/** Verify a separately uploaded candidate against the stored original. The host stores its nonempty byte parts under
 * their SHA references before start. Result metadata declares a promise to check; it supplies no trusted evidence. */
export interface ResumableVerificationOptions {
  readonly result: StoredResult<ImageResult>;
  readonly parts: readonly PartRef[];
  readonly maxPixels?: number;
}
type Saved<Options, Keys extends PropertyKey> = Options extends unknown ? Readonly<Pick<Options, Extract<Keys, keyof Options>>> & {
  readonly [K in Exclude<keyof Options, Keys>]?: never;
} : never;
/** encode, fit and variants save their data options: callbacks, signals and helpers belong to each call. */
export type ResumableUploadOptions<Operation extends Uploads> =
  Saved<NonNullable<Parameters<Operation>[1]>, 'fidelity' | 'effort' | 'readAs' | 'maxPixels' | 'features' | 'webgpu' | 'maxBytes' | 'outputs'>;

type OptionsOf<Operation extends ResumableOperation> = NonNullable<Parameters<Operation>[1]>;
export type ResumableOptions<Operation extends ResumableOperation> = Operation extends unknown
  ? Operation extends typeof verify ? ResumableVerificationOptions
  : Operation extends Uploads ? ResumableUploadOptions<Operation>
  : Operation extends typeof captureComplete ? ResumableCaptureCompleteOptions
  : 'fidelity' extends keyof OptionsOf<Operation> ? ResumableCaptureOptions
  : 'icc' extends keyof OptionsOf<Operation> ? ResumableJPEGOptions
  : ResumableRestoreOptions
  : never;
type InputOf<Operation extends ResumableOperation> = Operation extends unknown
  ? Operation extends typeof verify | Uploads ? ResumablePixels | ResumableFile
  : 'fidelity' extends keyof OptionsOf<Operation> ? ResumablePixels & {readonly colorSpace?: 'srgb' | 'display-p3'} : ResumableInput
  : never;

interface OperationContext<Operation extends ResumableOperation = ResumableOperation> {
  /** Pass the imported verb itself: capture, recompress, restore, encode, fit, variants or verify. */
  readonly operation: Operation;
  readonly store: ResumableStore;
}
/** The operation alone determines the admitted source and option shapes. */
export type StartOptions<Operation extends ResumableOperation = ResumableOperation> = Operation extends unknown ? OperationContext<Operation> & {
  readonly input: InputOf<NoInfer<Operation>>;
  /** rapier-jxl/verify's verify: verify in the advances and return the whole-file verifier's receipt at
   * result.verification. The plan saves that verification was chosen; pass the same verify to every advance. The host
   * supplies a decoder through configureDecoder where needed. */
  readonly verify?: Operation extends typeof verify ? never : typeof verify;
} & (undefined extends Parameters<NoInfer<Operation>>[1]
  ? {readonly options?: ResumableOptions<NoInfer<Operation>>}
  : {readonly options: ResumableOptions<NoInfer<Operation>>}) : never;
export interface FinishOptions<Operation extends ResumableOperation = ResumableOperation> extends OperationContext<Operation> {
  /** The input start was given, the same descriptor: a checkpoint of another original is refused. */
  readonly input: ResumableInput;
  readonly signal?: AbortSignal;
}
export interface AdvanceOptions extends FinishOptions {
  /** `ms`: positive milliseconds, at most 60000; defaults to {ms: 30}. A call advances at least one step. `reads`: the store
   * reads a call may make, for a host that allows few calls a request (none by default). */
  readonly budget?: {readonly ms: number; readonly reads?: number};
  /** rapier-jxl/verify's verify, for a job started with it (an advance without it refuses with JXL_OPTIONS). */
  readonly verify?: typeof verify;
}
export interface AdvanceResult {
  readonly checkpoint: Checkpoint;
  readonly done: boolean;
  /** The parts the given checkpoint reached and this one does not. Delete them once this checkpoint is kept, unless
   * another job's checkpoint reaches the same part (parts are content-addressed). */
  readonly released: readonly PartRef[];
}

/** Start the operation over the stored original and return its first durable checkpoint. */
export function start<Operation extends ResumableOperation>(options: OperationContext<Operation> & StartOptions<Operation>): Promise<Checkpoint>;
/** Advance the latest checkpoint within this call's budget, awaiting every new part's write. */
export function advance(checkpoint: Checkpoint, options: AdvanceOptions): Promise<AdvanceResult>;
type VerifiedResult<Result> = Result extends readonly (infer Item)[] ? Array<VerifiedResult<Item>>
  : Result & {readonly verification?: VerificationReceipt};
/** Assemble a finished checkpoint's output and return the ordinary result, or variants' list. verification is
 * present only when start asked for it. A verify job returns its receipt without reading either image.
 * finish does no whole-file hashing, decoding or scoring. */
export function finish<Operation extends ResumableOperation>(checkpoint: Checkpoint, options: FinishOptions<Operation>): Promise<
  Operation extends typeof verify ? VerificationReceipt : VerifiedResult<Awaited<ReturnType<Operation>>>>;

/** Whether a resumable job runs within a Cloudflare Workers isolate's 128 MB, from rapier-jxl's measured table: the
 * Node estimate (total peak minus bare runtime) x 1.1 <= 96,000,000 B, admitted only where every measured size up to the
 * first at least this large was admitted. A row not measured is not admitted. */
export interface WorkerAdmission {
  readonly admitted: boolean;
  /** The measured size the answer rests on, and its estimate in bytes; null where nothing was measured. */
  readonly measured: {readonly pixels: number; readonly estimate: number | null} | null;
}
export function workerAdmission(options: {readonly operation: ResumableOperation; readonly options?: object; readonly width: number; readonly height: number; readonly kind?: ResumableInput['kind']}): WorkerAdmission;

export {};
