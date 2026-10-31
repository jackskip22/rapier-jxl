import type {EncodeOptions as CoreOptions, ColorSpace} from './codec/index.mjs';
import type {AdvancedPhotoOptions} from './codec/photo-advanced.mjs';
import type {DecodedImage as CoreDecodedImage, DecodeOptions as CoreDecodeOptions} from './codec/decode.mjs';
import type {Metadata, CompressedMetadataOptions, BrotliCodec} from './codec/metadata.mjs';
import type {ContainerInspection, ReframeOptions} from './codec/container-advanced.mjs';
import type {Animation} from './codec/animation.mjs';
import type {FormatRequest, FormatOptions} from './format.mjs';

export type Samples = Uint8Array | Uint8ClampedArray | Uint16Array | Float32Array;
export type Bytes = Uint8Array<ArrayBuffer>;
export type Effort = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
/** Pixels describe themselves: what the samples are travels with them (SampleDescription). */
export interface Pixels extends SampleDescription { data: Samples; width: number; height: number; }
export interface CanvasSurface {
  readonly width: number; readonly height: number;
  getContext(contextId: '2d', options?: {willReadFrequently?: boolean}): unknown;
}
export interface BitmapSurface { readonly width: number; readonly height: number; close(): void; }
/** decode()'s result is an input too: its description says what its samples are. A canvas, bitmap or Blob is read in
 * sRGB, or its own space, unless the options' readAs names one. */
export type ImageInput = Pixels | DecodedImage | CanvasSurface | BitmapSurface | Blob;
/** signal: aborting rejects the job with the signal's reason. onProgress: 0 once started, rising to 1 before the result;
 * an onProgress that throws cancels the job, which rejects with what it threw. */
/** maxPixels: the largest picture this call admits, at most 40,000,000; under a codec the smaller of the two holds. */
export interface JobOptions { signal?: AbortSignal; onProgress?: (fraction: number) => void; maxPixels?: number; }

/**
 * The one fidelity choice; its shape is exclusive. 'exact': the decoded samples equal the input, bit for bit, in its
 * tagged color space. {quality}: 1 to 100, libjxl's quality at the same number; 100 is 'exact'. {ssimulacra2},
 * {butteraugli} (maximum) or {butteraugli3} (3-norm): the smallest file its search finds reaching that score under this
 * version's own metric, for 8-bit straight sRGB RGBA.
 * Default {quality: 90}.
 */
export type PixelFidelity = 'exact' | Sole<'quality'>;
export type MeasuredFidelity = Sole<'ssimulacra2'> | Sole<'butteraugli'> | Sole<'butteraugli3'>;
export type Fidelity = PixelFidelity | MeasuredFidelity;
/** A capture's fidelity: 'exact' (the default), or every sample within maxError of the input; 0 is 'exact'. */
export type MaxError = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type CaptureFidelity = 'exact' | Sole<'maxError', MaxError>;
/** One measure and no other, as the runtime refuses an object naming two. */
type FidelityKey = 'quality' | 'ssimulacra2' | 'butteraugli' | 'butteraugli3' | 'maxError';
type Sole<K extends FidelityKey, V = number> = {[P in K]: V} & {[P in Exclude<FidelityKey, K>]?: never};
/**
 * What the samples are, on the image itself (8.0: the image says what it is, the options what to make of it). A
 * description key in the options is refused with JXL_OPTIONS. Defaults: sRGB, its own transfer curve, the depth of the
 * array (Uint8Array 8, Uint16Array 16, Float32Array float), straight alpha. An ICC profile is the one authority when
 * given. orientation (the Exif value) and extraChannels need an 8-bit lossy encode in 8.0.0 (JXL_UNSUPPORTED otherwise).
 */
export interface SampleDescription {
  colorSpace?: CoreOptions['colorSpace'];
  transferFunction?: CoreOptions['transferFunction'];
  bitDepth?: CoreOptions['bitDepth'];
  sampleFormat?: CoreOptions['sampleFormat'];
  intensityTarget?: CoreOptions['intensityTarget'];
  alphaPremultiplied?: CoreOptions['alphaPremultiplied'];
  icc?: CoreOptions['icc'];
  orientation?: AdvancedPhotoOptions['orientation'];
  extraChannels?: AdvancedPhotoOptions['extraChannels'];
}
/** The description keys, refused in the options. */
type Described = {[K in keyof SampleDescription]?: never};
/** Codestream features an encode may set (level, upsampling, ...); `format()` authors whole structures. */
export type EncodeFeatures = Pick<AdvancedPhotoOptions, 'level' | 'upsampling' | 'upsamplingWeights' |
  'transforms' | 'quantization' | 'coefficientOrders' | 'progressive' | 'noise' | 'lfFrames'>;
/** Reads a canvas, bitmap or Blob in this space (a conversion where the source is another); pixels describe themselves. */
export type ReadAs = 'srgb' | 'display-p3';
/**
 * What the encoder should do. effort: 1 (fastest) to 9 (smallest), default 7; time for bytes at the same fidelity, the same
 * file on every host and device running this version; a later version may write different bytes for the same fidelity.
 * A lossy still at efforts 7-9 runs on WebGPU where the realm has a usable device and on WebAssembly otherwise
 * (CodecConfig.webgpu). A profile on the image is written in its smaller coding.
 * readAs: the space a canvas, bitmap or Blob is read in. A measured fidelity runs its own search over 8-bit straight
 * sRGB RGBA (the image's description must say so) and takes no features or profile.
 */
/** effort, readAs as above. webgpu: as CodecConfig.webgpu says (the call's wins over a codec's). maxPixels: at most
 * 40,000,000, the smaller of the call's and the codec's; a larger picture refuses with JXL_DIMENSIONS before any work. */
export type EncodeOptions = JobOptions & Described & {effort?: Effort; readAs?: ReadAs; webgpu?: 'required' | false; maxPixels?: number} & (
  {fidelity?: PixelFidelity; features?: EncodeFeatures} |
  {fidelity: MeasuredFidelity; features?: never}
);
/** rapier-jxl/upload's options: efforts 1-3 (default 3), 'exact' or a quality, with the full encoder's meanings.
 * webgpu is taken and changes nothing: efforts 1-3 never ask for a device. */
export type UploadOptions = JobOptions & Described & {fidelity?: PixelFidelity; effort?: 1 | 2 | 3; readAs?: ReadAs;
  webgpu?: 'required' | false; maxPixels?: number};
/** An animation describes its frames' samples as a still does, without orientation or extra channels. */
export type AnimationInput = Animation & Omit<SampleDescription, 'orientation' | 'extraChannels'>;
/** An animation, {width, height, frames}: 'exact' or a quality for every frame; no measured target, no `features`. */
export type AnimationOptions = JobOptions & Described & {fidelity?: PixelFidelity; effort?: Effort; features?: never};
/** A capture runs on WebAssembly; the pixels say their colorSpace, readAs reads a canvas, bitmap or Blob in a chosen one. */
export type CaptureOptions = JobOptions & Described & {fidelity?: CaptureFidelity; readAs?: ReadAs};
/** JPEG recompression runs on WebAssembly. */
export interface JPEGOptions extends JobOptions {
  effort?: Effort; icc?: 'preserve';
}
/** The decoder's work counters stay internal at their defaults; a lowered maxTotalSamples also caps the samples held at once. */
type DecodeInternals = 'maxSamples' | 'maxRetainedSamples' | 'maxModularWork' | 'maxFeatureBytes' | 'maxFeatureWork';
export type DecodeOptions = Omit<CoreDecodeOptions, DecodeInternals> & JobOptions;
/** details: 'metadata' (Exif, XMP, JUMBF) and 'layout' (the container: boxes, fragments, the codestream). None by
 * default: the header alone, no metadata inflated, no copy of the codestream. */
export type InspectOptions = Pick<CoreDecodeOptions, 'maxPixels' | 'maxDimension' | 'maxMetadataBytes' | 'maxInputBytes' | 'maxBoxes'> &
  {details?: ('metadata' | 'layout')[];
    /** A Brotli decoder for compressed metadata the built-in reader does not take; with details metadata. */
    decompress?: BrotliCodec};
/** What inspect reads with no pixel decoded: the image header, and each detail asked for. A field absent because it was
 * not asked for says nothing about the file. `reconstruction`: a JPEG reconstruction box was among the bytes read. It
 * does not prove restore will succeed, and false on a file's first bytes says nothing; restore decides. */
export type ImageInfo = ImageHeader & {metadata?: Metadata; layout?: ContainerInspection};
/** A color encoding as a file names it, and as decoded samples are in. */
export interface ColorEncoding {
  /** 'cmyk': a CMYK profile describes decoded native planes (JPEG XL stores them inverted, as ink). */
  space: 'rgb' | 'gray' | 'xyb' | 'cmyk' | 'unknown';
  whitePoint?: 'd65' | 'e' | 'dci' | 'd50' | [number, number];
  primaries?: 'srgb' | 'display-p3' | 'rec2020' | [[number, number], [number, number], [number, number]];
  /** 'icc': an ICC profile describes the samples (decode's icc or rgbaICC), and no white point or primaries stand beside it. */
  transferFunction?: 'srgb' | 'linear' | 'bt709' | 'dci' | 'pq' | 'hlg' | 'gamma' | 'unknown' | 'icc';
  gamma?: number;
  renderingIntent?: 0 | 1 | 2 | 3;
  /** Decoded samples a profile describes: the profile's color space signature ('RGB ', 'GRAY', 'CMYK', ...). */
  iccSpace?: string;
  /** Decoded CMYK samples: true, as JPEG XL stores ink inverted. */
  invertedCMYK?: boolean;
}
export interface HeaderBitDepth {bits: number; exponentBits: number; float: boolean}
/** An extra channel as the header declares it. type: alpha 0, depth 1, spot 2, selection 3, black 4, CFA 5, thermal 6,
 * optional 15, nonoptional 16. dimShift: the channel's resolution is the image's divided by 2 ** dimShift. */
export interface ExtraChannelInfo {type: number; bitDepth: HeaderBitDepth; dimShift: number; name: string; associated: boolean;
  spotColor?: [number, number, number, number]; cfaChannel?: number}
/** The image header: header() returns it, inspect() adds the details asked for, and decode() returns it as `header`.
 * `reconstruction`: a JPEG reconstruction box was among the bytes read (on a file's first bytes, false says nothing). */
export interface ImageHeader {
  width: number; height: number;
  /** The Exif value, 1-8. */
  orientation: number;
  intrinsicSize: {width: number; height: number} | null;
  preview: {width: number; height: number} | null;
  animation: {numerator: number; denominator: number; loops: number; timecodes: boolean} | null;
  bitDepth: HeaderBitDepth;
  extraChannels: ExtraChannelInfo[];
  colorEncoding: ColorEncoding;
  /** HDR: the brightness the samples were graded for, in nits, and how to map them below it. */
  toneMapping: {intensityTarget: number; minNits: number; relativeToMaxDisplay: boolean; linearBelow: number};
  reconstruction: boolean;
  /** decode's header only: the file's own ICC profile, whatever space the samples were decoded to. header() and inspect()
   * read no profile. */
  icc?: Uint8Array;
}
/** The header alone, read synchronously (rapier-jxl/metadata header): no metadata is read, so no maxMetadataBytes. */
export type HeaderOptions = Omit<InspectOptions, 'details' | 'decompress' | 'maxMetadataBytes'>;
/** edit's changes: the metadata (exif, xmp, jumb; null removes, undefined keeps; compression) first, then the
 * container's framing (chunkSize, fragmentOrder, ...); the codestream and every other box stay exact. */
export type EditChanges = Pick<CompressedMetadataOptions, 'exif' | 'xmp' | 'jumb' | 'compression' | 'compress'> &
  Pick<ReframeOptions, 'chunkSize' | 'fragmentOrder' | 'minorVersion' | 'frameStarts' | 'allowBufferedFrameEnds' | 'iccBitLength' | 'extended' | 'level'> &
  {maxInputBytes?: number; maxBoxes?: number};
/** decode()'s result, with what its RGBA samples are in encode's words, so it goes straight back into encode. `icc` is
 * the file's own profile; rgbaICC is the one that describes `data`. colorSpace and transferFunction are absent when the
 * encoding has no name encode knows, or when rgbaICC describes the samples. Changing one of these fields and passing the
 * result to encode is refused (JXL_INPUT): retag by passing {data, width, height, ...description}. */
/** Decoded samples: 8-bit as a Uint8ClampedArray (what ImageData takes), 16-bit as Uint16Array, float as Float32Array. */
export type DecodedSamples = Uint8ClampedArray | Uint16Array | Float32Array;
type Clamped<T> = Omit<T, 'data' | 'colorEncoding' | 'rgbaColorEncoding'> & {data: DecodedSamples; colorEncoding: ColorEncoding; rgbaColorEncoding: ColorEncoding};
/** `header` is the whole file's image header, as decode parsed it: header()'s fields for the same file, plus `icc`, the
 * file's own profile (header() reads no profile and may read only the file's first bytes). `metadata` (Exif, XMP,
 * JUMBF) is inspect's detail, as everywhere. */
export type DecodedImage = Omit<CoreDecodedImage, 'data' | 'frames' | 'preview' | 'metadata' | 'colorEncoding' | 'rgbaColorEncoding'> & {data: DecodedSamples;
  colorEncoding: ColorEncoding; rgbaColorEncoding: ColorEncoding; header: ImageHeader;
  frames: Clamped<CoreDecodedImage['frames'][number]>[]; preview: Clamped<NonNullable<CoreDecodedImage['preview']>> | null;
  bitDepth: 8 | 16 | 32; sampleFormat: 'uint' | 'float32'; colorSpace?: ColorSpace; transferFunction?: CoreOptions['transferFunction']};
/**
 * The code every refusal carries, by what the caller does next. The call: JXL_OPTIONS. The input: JXL_INPUT,
 * JXL_DIMENSIONS, JXL_JPEG, JXL_DECODE, JXL_RECONSTRUCTION (no JPEG reconstruction data), JXL_TARGET (a measured
 * fidelity this version cannot reach), JXL_PLATFORM (an input this realm cannot decode). A bound: JXL_MEMORY (the
 * queue's maxPendingBytes, maxPendingJobs), JXL_LIMIT (a parser's maxInputBytes or maxBytes). The host: JXL_WASM,
 * JXL_WEBGPU (a codec with webgpu: 'required' and a lossy job at efforts 7-9 it would otherwise run on WebAssembly: no
 * usable device, a device that failed the job, or a route this version runs on WebAssembly only), JXL_WORKER, JXL_WORKER_CSP,
 * JXL_WORKER_TIMEOUT. The lifecycle: JXL_CLOSED, and JXL_ABORTED where a signal aborts
 * without a reason; a job canceled through its signal otherwise rejects with that signal's reason, an AbortError
 * DOMException unless you passed one. Not done by this version: JXL_UNSUPPORTED, a valid request or file asking for
 * something this version does not do. Ours: JXL_INTERNAL. A code keeps its meaning through 8.x; a later 8.x may add one.
 */
export type ErrorCode =
  | 'JXL_OPTIONS' | 'JXL_INPUT' | 'JXL_DIMENSIONS' | 'JXL_JPEG' | 'JXL_DECODE' | 'JXL_RECONSTRUCTION' | 'JXL_TARGET' | 'JXL_PLATFORM'
  | 'JXL_MEMORY' | 'JXL_LIMIT' | 'JXL_WASM' | 'JXL_WEBGPU' | 'JXL_WORKER' | 'JXL_WORKER_CSP' | 'JXL_WORKER_TIMEOUT'
  | 'JXL_ABORTED' | 'JXL_CLOSED' | 'JXL_UNSUPPORTED' | 'JXL_INTERNAL';
export interface CodecError extends Error { readonly code: ErrorCode; }
export type {Animation, FormatRequest, FormatOptions};
/** A worker the codec talks to: a browser or Deno Worker (addEventListener with removeEventListener), or Node's
 * worker_threads Worker (on with off). */
export type WorkerLike = {
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  terminate(): void | Promise<number>;
} & ({
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
} | {
  on(type: string, listener: (...args: any[]) => void): unknown;
  off(type: string, listener: (...args: any[]) => void): unknown;
});
export interface CodecConfig {
  /** Returns a fresh worker running this module's worker file each time it is called. The codec owns it: it may end
   * it and start another (when a job running on it is canceled, or the worker stops), and ends the last on close(). */
  workerFactory?: () => WorkerLike;
  workerStartupTimeout?: number;
  /** A job is pending from acceptance until its resources are released, queued or running; a canceled running job has
   * rejected but stays pending until its work lets go of them. The pending jobs' retained input and options together,
   * in bytes (default 256 MiB); a job past it refuses JXL_MEMORY. */
  maxPendingBytes?: number;
  /** The largest picture any operation admits, restore included: default and at most 40,000,000 pixels; 16,384 a side. */
  maxPixels?: number;
  /** Pending jobs, queued or running, at once; one more refuses JXL_MEMORY. */
  maxPendingJobs?: number;
  /**
   * Helper workers granted only from this reservation: at most `count` helpers (0–16) inside `memoryBytes`, the codec's
   * until close(): prepare() may start them before a job, and one that ends is replaced. None by default; the CPU count
   * grants nothing.
   * The bytes are the same with any number of helpers.
   */
  helpers?: { count: number; memoryBytes: number };
  /**
   * A lossy still at efforts 7-9 runs on WebGPU where this realm has a usable device (by default from the size this
   * version measured it faster) and on WebAssembly otherwise: the same file, more slowly.
   * 'required': the GPU, at any size, or a refusal (JXL_WEBGPU) for a lossy job at efforts 7-9 that this codec would
   * otherwise run on WebAssembly: no WebGPU adapter; a device that will not open or fails during the job; a route the
   * call chooses that this version runs on WebAssembly only (an animation, a measured fidelity, codestream features,
   * an ICC profile, deeper or HDR samples, premultiplied alpha, a color space other than sRGB). Which coding a picture's
   * content selects (a screen, a palette) never refuses. prepare('encode') refuses without an adapter.
   * false: never ask for a device. Efforts 1-6, exact pictures and the other operations never need one.
   */
  webgpu?: 'required' | false;
}
export interface CodecStats {
  readonly queuedJobs: number; readonly queuedBytes: number;
  readonly activeJobs: number; readonly activeBytes: number;
  readonly closed: boolean;
}
// The codecs over each module are declared in codec.d.mts.
