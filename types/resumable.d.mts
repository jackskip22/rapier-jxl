import type {capture} from './capture.mjs';
import type {capture as captureComplete, CaptureCompleteOptions} from './capture-complete.mjs';
import type {recompress, restore, RecompressOptions} from './jpeg.mjs';
import type * as root from './index.mjs';
import type * as upload from './upload.mjs';
import type {Bytes, CaptureOptions, JobOptions, Pixels} from './types.mjs';
import type {VerificationReceipt} from './verify.mjs';
import type {verify} from './verify.mjs';
import type {ImageResult} from './result.mjs';


type Awaitable<T> = T | PromiseLike<T>;

declare const operationSteps: unique symbol;
/** A callable carrying its own resumable steps. The private marker exists only in the type system. */
export type ResumableFunction<Call extends (...args: never[]) => unknown> = Call & {readonly [operationSteps]: unknown};

/** The immutable original held by the store. generation is a nonempty host identifier (at most 256 characters),
 * and sha256 is the original bytes' SHA-256 as 64 lowercase hexadecimal characters, without a prefix.
 * JPEG operations read file bytes. Capture reads straight RGBA8 rows described by ResumablePixels. Encode, fit and
 * variants and verify read either, an encoded file named by kind 'file' (ResumableFile). Encode and fit also read a JPEG XL
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
  /** The profile's rendering intent where it is not relative (0, 2 or 3). The file's header carries it. */
  readonly renderingIntent?: 0 | 1 | 2 | 3;
}

/** Straight RGBA8 rows: positive pixel dimensions. byteLength is width * height * 4. */
export interface ResumablePixels extends ResumableInput {
  readonly kind?: 'pixels';
  readonly width: number;
  readonly height: number;
}
/** An encoded file (JPEG, PNG, WebP and the others an upload reads), read in the job's own steps. */
export interface ResumableFile extends ResumableInput {
  readonly kind: 'file';
}

/** A stored JPEG XL, such as a JPEG's lossless one, whose picture is its decode: jpegxl/decode's decode, set once with
 * configureDecoder(decode) from jpegxl/verify. The job encodes the decoded pixels, as encode() of them would. */
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
 * the exact requested byte range or part. A readMany result follows its references' order. */
interface StoreReads {
  readSource(offset: number, length: number): Awaitable<Uint8Array>;
  read(ref: PartRef): Awaitable<Uint8Array>;
  readMany?(refs: readonly PartRef[]): Awaitable<readonly Uint8Array[]>;
}
/** write keeps one part. writeMany keeps a call's parts in one request. A store has either, or both. */
export type ResumableStore = StoreReads & (
  {write(ref: PartRef, bytes: Bytes): Awaitable<void>; writeMany?(parts: readonly {readonly ref: PartRef; readonly bytes: Bytes}[]): Awaitable<void>} |
  {write?(ref: PartRef, bytes: Bytes): Awaitable<void>; writeMany(parts: readonly {readonly ref: PartRef; readonly bytes: Bytes}[]): Awaitable<void>});

declare const checkpointBrand: unique symbol;
/** An opaque JSON record returned by start or advance. Persist it unchanged after the call's writes finish,
 * using revision to guard the host's save, and pass the latest saved record to the next call. The driver
 * rejects stale, changed or foreign records. Keep checkpoints where only your service writes them. The original and
 * parts may be in any store, and every byte read back is checked. The brand exists only in the type system. */
export interface Checkpoint {
  readonly revision: number;
  readonly [checkpointBrand]: true;
}

type Uploads = typeof root.encode | typeof root.fit | typeof root.variants | typeof upload.encode | typeof upload.fit | typeof upload.variants;
/** Resumable verbs: encode/fit/variants from jpegxl or jpegxl/upload, capture from jpegxl/capture or
 * jpegxl/capture-complete (every effort), recompress/restore from jpegxl/jpeg, and verify from jpegxl/verify. */
export type ResumableOperation = typeof capture | typeof captureComplete | typeof recompress | typeof restore | typeof verify | Uploads;

type OptionKeys = keyof CaptureOptions | keyof RecompressOptions;
type SavedOptions<Options, Keys extends keyof Options> = Readonly<Pick<Options, Keys>> & {
  readonly [K in Exclude<OptionKeys, Keys>]?: never;
};
/** Capture's data-only saved options. Per-call cancellation is supplied to advance or finish. */
export type ResumableCaptureOptions = SavedOptions<CaptureOptions, 'fidelity' | 'effort'>;
/** capture-complete's data-only saved options: its rectangles too. */
export type ResumableCaptureCompleteOptions = Saved<CaptureCompleteOptions, 'fidelity' | 'effort' | 'webgpu' | 'exactRects' | 'photoRects' | 'textComplete' | 'maxPixels'>;
/** Recompression preserves the JPEG's coefficients and takes these ordinary JPEG settings. */
export type ResumableJPEGOptions = SavedOptions<RecompressOptions, 'effort' | 'maxPixels' | 'gainMap'>;
/** Restoration admits only the pixel bound in its saved plan. */
export type ResumableRestoreOptions = SavedOptions<JobOptions, 'maxPixels'>;
type StoredResult<Result> = Result extends {readonly bytes: Bytes} ? Omit<Result, 'bytes'> & {readonly bytes?: never; readonly verification?: never} : never;
/** Verify a separately uploaded candidate against the stored original. The host stores its nonempty byte parts under
 * their SHA references before start. Result metadata declares a promise to check. It supplies no trusted evidence. */
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
  Saved<NonNullable<Parameters<Operation>[1]>, 'fidelity' | 'effort' | 'progressive' | 'jpeg' | 'readAs' | 'maxPixels' | 'firstRegion' | 'webgpu' | 'maxBytes' | 'outputs'>;

type OptionsOf<Operation extends ResumableOperation> = NonNullable<Parameters<Operation>[1]>;
/** The data options an operation saves in its plan. Callbacks and signals belong to each call. */
export type ResumableOptions<Operation extends ResumableOperation> = Operation extends unknown
  ? Operation extends typeof verify ? ResumableVerificationOptions
  : Operation extends Uploads ? ResumableUploadOptions<Operation>
  : Operation extends typeof captureComplete ? ResumableCaptureCompleteOptions
  : 'fidelity' extends keyof OptionsOf<Operation> ? ResumableCaptureOptions
  : 'effort' extends keyof OptionsOf<Operation> ? ResumableJPEGOptions
  : ResumableRestoreOptions
  : never;
type InputOf<Operation extends ResumableOperation> = Operation extends unknown
  ? Operation extends typeof root.encode | typeof root.fit | typeof upload.encode | typeof upload.fit ? ResumablePixels | ResumableFile | ResumableDecode
  : Operation extends typeof verify | Uploads ? ResumablePixels | ResumableFile
  : 'fidelity' extends keyof OptionsOf<Operation> ? ResumablePixels & {readonly colorSpace?: 'srgb' | 'display-p3'} : ResumableInput
  : never;

interface OperationContext<Operation extends ResumableOperation = ResumableOperation> {
  /** Pass the imported verb itself: capture, recompress, restore, encode, fit, variants or verify. */
  readonly operation: Operation;
  /** Where the original, parts and checkpoints live. Every call of one job gets the same store. */
  readonly store: ResumableStore;
  /** Optional memory admission, in bytes, on each call. Uses measured working sets with 10% headroom and
   * 32,000,000 bytes for the host. Unmeasured sizes, source types or verification choices refuse with JXL_MEMORY.
   * Measurements cover PNG8 encode/fit and baseline 4:2:0 JPEG recompress. On advance it also bounds what a call holds
   * of the job's saved values (JXL_MEMORY past it). Without it the host's allocation is the limit. */
  readonly memoryBytes?: number;
}
/** The operation alone determines the admitted source and option shapes. */
export type StartOptions<Operation extends ResumableOperation = ResumableOperation> = Operation extends unknown ? OperationContext<Operation> & {
  readonly input: InputOf<NoInfer<Operation>>;
  /** jpegxl/verify's verify: verify in the advances and return the whole-file verifier's receipt at
   * result.verification. The plan saves that verification was chosen. Pass the same verify to every advance. The host
   * supplies a decoder through configureDecoder where needed. */
  readonly verify?: Operation extends typeof verify ? never : typeof verify;
} & (undefined extends Parameters<NoInfer<Operation>>[1]
  ? {readonly options?: ResumableOptions<NoInfer<Operation>>}
  : {readonly options: ResumableOptions<NoInfer<Operation>>}) : never;
export interface FinishOptions<Operation extends ResumableOperation = ResumableOperation> extends OperationContext<Operation> {
  /** The input start was given, the same descriptor: a checkpoint of another original is refused. */
  readonly input: InputOf<NoInfer<Operation>>;
  /** Aborts this call. The job stays resumable from its last checkpoint. Explicit undefined is accepted. */
  readonly signal?: AbortSignal | undefined;
}
export interface AdvanceOptions<Operation extends ResumableOperation = ResumableOperation> extends FinishOptions<Operation> {
  /** `ms`: positive milliseconds, at most 60000. Defaults to {ms: 30}. A call advances at least one step. `reads`: the store
   * reads a call may make, for a host that allows few calls a request (none by default). */
  readonly budget?: {readonly ms: number; readonly reads?: number};
  /** jpegxl/verify's verify, for a job started with it (an advance without it refuses with JXL_OPTIONS). */
  readonly verify?: typeof verify;
}
export interface AdvanceResult {
  readonly checkpoint: Checkpoint;
  readonly done: boolean;
  /** The parts the given checkpoint reached and this one does not. Delete them once this checkpoint is kept, unless
   * another job's checkpoint reaches the same part (parts are content-addressed). */
  readonly released: readonly PartRef[];
}

/** Start the operation over the stored original and return its first durable checkpoint.
 * Invalid operation, store or verification settings refuse JXL_OPTIONS. An operation without resumable steps refuses JXL_UNSUPPORTED. Missing decoder or verification setup refuses JXL_PLATFORM.
 * @example const checkpoint = await start({operation: encode, store, input, options: {fidelity: {quality: 82}}}); // encode from jpegxl/upload */
export function start<Operation extends ResumableOperation>(options: OperationContext<Operation> & StartOptions<Operation>): Promise<Checkpoint>;
/** Advance the latest checkpoint within this call's budget, awaiting every new part's write.
 * Invalid budget.ms or budget.reads, or a missing verifier for a verifying checkpoint, refuses JXL_OPTIONS.
 * @example const {done, checkpoint: next} = await advance(checkpoint, {operation: encode, store, input}); */
export function advance<Operation extends ResumableOperation>(checkpoint: Checkpoint, options: AdvanceOptions<Operation>): Promise<AdvanceResult>;
type VerifiedResult<Result> = Result extends readonly (infer Item)[] ? Array<VerifiedResult<Item>>
  : Result & {readonly verification?: VerificationReceipt};
/** Assemble a finished checkpoint's output and return the ordinary result, or variants' list. verification is
 * present only when start asked for it. A verify job returns its receipt without reading either image.
 * finish does no whole-file hashing, decoding or scoring.
 * An assembled result beyond memoryBytes or a failed allocation refuses JXL_MEMORY. Incomplete or missing saved output refuses JXL_INPUT.
 * @example const {bytes} = await finish(checkpoint, {operation: encode, store, input}); */
export function finish<Operation extends ResumableOperation>(checkpoint: Checkpoint, options: FinishOptions<Operation>): Promise<
  Operation extends typeof verify ? VerificationReceipt : VerifiedResult<Awaited<ReturnType<Operation>>>>;

/** Whether a resumable job runs within a Cloudflare Workers isolate's 128 MB, from jpegxl's measured table: the
 * Node estimate (total peak minus bare runtime) x 1.1 <= 96,000,000 B, admitted only where every measured size up to the
 * first at least this large was admitted. Pass the imported operation function (encode, recompress, etc.), never
 * the operation name as a string. The answer rests on the next measured size bucket at least width x height pixels,
 * which can be larger than the requested picture. A size without a matching row is not admitted. */
export interface WorkerAdmission {
  readonly admitted: boolean;
  /** The next measured size at least the requested pixel count, with estimated bytes. null without a row.
 * Invalid dimensions, kind or operation value refuse JXL_OPTIONS. An operation without resumable steps refuses JXL_UNSUPPORTED. */
  readonly measured: {readonly pixels: number; readonly estimate: number | null} | null;
}
/** Malformed option records, unknown option keys and invalid maxPixels refuse JXL_OPTIONS.
 * Verification estimates read result.kept; stored result and part identities are checked when the job starts.
 * @example const {admitted} = workerAdmission({operation: encode, width: 4032, height: 3024}); */
export function workerAdmission<Operation extends ResumableOperation>(options: {readonly operation: Operation; readonly options?: ResumableOptions<NoInfer<Operation>>; readonly width: number; readonly height: number; readonly kind?: ResumableInput['kind']}): WorkerAdmission;

export {};

/** Codes for refusals raised by rapier-jxl. Caller callback errors and abort reasons pass through unchanged. */
export type {CodecError, ErrorCode} from './types.mjs';
