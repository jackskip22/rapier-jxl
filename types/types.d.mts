import type {EncodeOptions as CoreOptions, ColorSpace} from './codec/index.mjs';
import type {ResultMeasurement} from './result.mjs';
import type {AdvancedPhotoOptions} from './codec/photo-advanced.mjs';
import type {DecodedImage as CoreDecodedImage, DecodeOptions as CoreDecodeOptions} from './codec/decode.mjs';
import type {Metadata, CompressedMetadataOptions, BrotliCodec as CoreBrotliCodec} from './codec/metadata.mjs';
import type {ContainerInspection, ReframeOptions} from './codec/container-advanced.mjs';
import type {Animation as CoreAnimation} from './codec/animation.mjs';
import type {FormatRequest, FormatOptions} from './format.mjs';
export type {ImageJob, ImageVerb, Digest, ResultSource, ResultReason, ResultTransform, ResultFidelity, ResultMeasurement, ImageResult, EncodedResult} from './result.mjs';

/** Half floats as a Float16Array holds them (typed here by its shape: TypeScript's lib has the global only in esnext).
 * Read as sampleFormat 'float16', as a Uint16Array of their bits with sampleFormat 'float16' is. */
export interface Float16Samples extends ArrayBufferView { readonly [Symbol.toStringTag]: 'Float16Array'; readonly length: number; [index: number]: number; }
/** The typed arrays a picture's samples may be in: 8 or 16 bit integers, half or full floats. */
export type Samples = Uint8Array | Uint8ClampedArray | Uint16Array | Float16Samples | Float32Array;
/** Library-produced bytes own an ArrayBuffer; caller byte inputs accept plain Uint8Array. */
export type Bytes = Uint8Array<ArrayBuffer>;
/** Metadata callbacks receive owned bytes and may return bytes immediately or through any thenable. */
type BrotliCodec = (bytes: Bytes, options: Parameters<CoreBrotliCodec>[1]) => Uint8Array | PromiseLike<Uint8Array>;
/** 1 (fastest) to 9 (smallest file). */
export type Effort = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
/** Pixels describe themselves: what the samples are travels with them (SampleDescription). */
/** A picture is width x height pixels of straight RGBA samples. Float pictures (a Float32Array, a Float16Array, or a Uint16Array
 * with sampleFormat 'float16') may be packed RGB instead, three samples a pixel, and then take alpha 1. */
export interface Pixels extends SampleDescription { data: Samples; width: number; height: number; }
/** A 2D, WebGL or WebGPU canvas, or an OffscreenCanvas, read at its size. */
export interface CanvasSurface {
  readonly width: number; readonly height: number;
  getContext(contextId: '2d', options?: {willReadFrequently?: boolean}): unknown;
}
/** An ImageBitmap, read at its size. The caller keeps it and closes it. */
export interface BitmapSurface { readonly width: number; readonly height: number; close(): void; }
/** A WebCodecs VideoFrame (a camera, a screen capture, a decoded video): read at its display size, converted by the
 * browser from its own color space to sRGB, or to readAs. The caller keeps it and closes it. */
export interface FrameSurface { readonly displayWidth: number; readonly displayHeight: number; close(): void; }
/** decode()'s result is an input too: its description says what its samples are. When pixels are needed, a canvas
 * (2D, WebGL or WebGPU), bitmap, video frame or Blob is read in sRGB, or its own space, unless readAs names one. Through a module's queue
 * whose jobs run in a worker, a canvas, bitmap or video frame is taken as a snapshot at the call and read there. */
/** A <video> (playing, or paused on a frame): read as the frame it shows, as a VideoFrame of it is. Refused JXL_INPUT
 * before it has a frame (readyState below 2) or when the browser will not read it (cross-origin without CORS). */
export interface VideoSurface { readonly videoWidth: number; readonly videoHeight: number; readonly readyState: number; }
/** What an encode, fit or variants call reads: pixels, a decode result, a canvas, bitmap, video frame, Blob, rows or a GPU texture. */
export type ImageInput = Pixels | DecodedImage | CanvasSurface | BitmapSurface | FrameSurface | VideoSurface | Blob | RowSource | TextureInput;
/** Upload keeps the universal image inputs except GPU textures, which the full encoder reads. */
export type UploadInput = Exclude<ImageInput, TextureInput>;
/** A capture takes straight RGBA8, not the deeper sample descriptions accepted by encode. */
export interface CapturePixels extends Pixels {
  data: Uint8Array | Uint8ClampedArray;
  colorSpace?: 'srgb' | 'display-p3';
  transferFunction?: 'srgb';
  bitDepth?: 8;
  sampleFormat?: 'uint';
  intensityTarget?: 255;
  alphaPremultiplied?: false;
  icc?: never;
  orientation?: 1;
  extraChannels?: readonly [];
}
/** A capture's supplied pixels and row bands are 8-bit. */
/** decode() can return 16-bit or float samples, which capture refuses. Only a verified 8-bit
 * decoded result is a capture input; color/profile/alpha/orientation are still admitted at runtime. */
type CaptureDecodedImage = DecodedImage & {readonly format: 'uint8'; readonly data: Uint8ClampedArray};
/** What a capture reads: ImageInput with 8-bit pixels only. */
export type CaptureInput = Exclude<ImageInput, Pixels | DecodedImage | RowSource> | CapturePixels | CaptureDecodedImage | CaptureRowSource;
/** Upload's capture: its inputs, with pixels the caller makes 8-bit. */
export type UploadCaptureInput = Exclude<CaptureInput, TextureInput>;
/** Preparation owns one still image. Streamed rows are encoded directly. */
export type PreparationInput = Exclude<ImageInput, RowSource>;
/** A WebGPU texture (2D, one sample, COPY_SRC usage; rgba8unorm, bgra8unorm, their -srgb forms, rgba16float or
 * rgba32float), read from mip level 0 and its `layer` in the realm of its device: the copy is submitted at the call, so GPU work
 * submitted later does not reach the file. A texture carries no color meaning: the description says it; unsaid, 8-bit
 * formats are sRGB and float formats linear sRGB. Through a module's worker queue it is read in the page, then queued. */
export interface GPUTextureLike {readonly width: number; readonly height: number; readonly format: string; readonly usage: number; readonly dimension: string; readonly sampleCount: number; readonly depthOrArrayLayers?: number}
/** An extra channel read from a texture of the input's device (a depth buffer: depth16unorm, depth32float, r16uint,
 * r16float or r32float), from the input's layer, at the picture's size or its 2^dimShift reduction. */
export type TextureChannel = Omit<NonNullable<AdvancedPhotoOptions['extraChannels']>[number], 'data' | 'bitDepth' | 'sampleFormat' | 'exponentBits'> & {texture: GPUTextureLike; data?: never};
/** A GPU texture read from its own device, at the encoder's size; jpegxl and capture-complete take it. */
export interface TextureInput extends Omit<SampleDescription, 'extraChannels'> {
  texture: GPUTextureLike;
  /** Required to contain failed texture copies, including destroyed or invalid source textures. */
  /** The GPU operations used by readback, without a dependency on ambient WebGPU declarations.
   * Native GPUDevice and GPUQueue satisfy this structural contract. */
  device: {
    readonly queue: {submit(commandBuffers: Iterable<unknown>): void};
    createBuffer(descriptor: {size: number; usage: number}): {
      mapAsync(mode: number): Promise<void>;
      getMappedRange(): ArrayBuffer;
      unmap(): void;
      destroy(): void;
    };
    createCommandEncoder(): {
      copyTextureToBuffer(source: unknown, destination: unknown, copySize: unknown): void;
      finish(): unknown;
    };
    pushErrorScope(filter: 'validation'): void;
    popErrorScope(): Promise<unknown>;
  };
  /** The array layer read: a WebXR projection layer holds one eye per layer. Default 0. */
  layer?: number;
  /** Written lossy. An exact picture with extra channels is format({kind: 'channels'}) from jpegxl/format; asked here, it refuses JXL_UNSUPPORTED. */
  extraChannels?: readonly ((NonNullable<AdvancedPhotoOptions['extraChannels']>[number] & {texture?: never}) | TextureChannel)[];
}
/** A picture given a band of rows at a time, so it is never whole in memory: rows(y, count) returns rows y to
 * y + count - 1 as {data} (width x count RGBA samples, described by the source) or a canvas, bitmap or video frame of
 * width x count (8-bit, in the source's colorSpace: sRGB or Display P3). Bands are asked for top to bottom and may be
 * asked for again; each is copied as it arrives, so its buffer may be reused. Coded in bands of about 4 MP. Through a
 * worker queue the page answers the worker's asks. No readAs, orientation, extra channels, measured fidelity or features. */
export interface RowSource extends Omit<SampleDescription, 'orientation' | 'extraChannels'> {
  width: number; height: number;
  orientation?: never; extraChannels?: never;
  rows(y: number, count: number): RowBand | PromiseLike<RowBand>;
}
export type RowBand = {data: Samples} | CanvasSurface | BitmapSurface | FrameSurface;
/** Capture row bands supply 8-bit pixels or a native surface. */
export type CaptureRowBand = {data: CapturePixels['data']} | CanvasSurface | BitmapSurface | FrameSurface;
export interface CaptureRowSource extends RowSource {
  colorSpace?: 'srgb' | 'display-p3';
  transferFunction?: 'srgb';
  bitDepth?: 8;
  sampleFormat?: 'uint';
  intensityTarget?: 255;
  alphaPremultiplied?: false;
  icc?: never;
  rows(y: number, count: number): CaptureRowBand | PromiseLike<CaptureRowBand>;
}
/** signal: aborting rejects the job with the signal's reason. onProgress: 0 once started, rising to 1 before the result;
 * a thrown or rejected callback value rejects the job unchanged; callbacks settle before success, unless aborted. */
/** maxPixels: the largest picture this call admits, the caller's bound; none by default. A side is at most 2^30 (the JPEG
 * XL size field); under configure's the smaller of the two holds. Above 40,000,000 an encode or
 * capture is coded in bands of about 4 MP, composed as one still, so working memory stays about one band's beside the
 * input. Where the host cannot hold the work, the call refuses JXL_MEMORY. */
export interface JobOptions {
  /** Aborting before this call's promise settles rejects it with the signal's reason.
   * Share one AbortController's signal among calls to cancel them together.
   * A call whose promise has already settled keeps its result. */
  signal?: AbortSignal | undefined;
  /** Called with 0 when the job starts, rising to 1 before the result; a throw or rejection cancels the job. */
  onProgress?: ((fraction: number) => void) | ((fraction: number) => PromiseLike<void>) | undefined;
  /** Most pixels the call admits; none by default. Larger refuses JXL_DIMENSIONS. */
  maxPixels?: number;
}

/** A complete candidate, before the final result. Its bytes belong to the observer; measurements contain only
 * scores already computed for this file. Candidates can grow or lose quality while the encoder searches. */
export interface ImagePreview {
  readonly bytes: Bytes;
  readonly width: number;
  readonly height: number;
  readonly measurements: readonly ResultMeasurement[];
}
/** Latest only, at most every 100 ms. A returned promise delays the next preview; delivered observers settle before
 * success, unless aborted, and thrown or rejected values reject the operation unchanged. Undelivered previews are
 * discarded on completion or cancellation; the final result is separate. */
export interface PreviewOptions {
  /** Called with the latest complete candidate file, at most every 100 ms, while the encoder searches. */
  onPreview?: ((preview: ImagePreview) => void | PromiseLike<void>) | undefined;
}

/**
 * The one fidelity choice; its shape is exclusive. For a pixel encode, 'exact' reproduces the input samples in their
 * tagged color space. {quality}: 1 to 100, fractions allowed; 100 is 'exact'. The number aims at a measured SSIMULACRA 2
 * look, and the file is the smallest this version finds with that look (a prediction calibrated on measured photos, not a
 * per-picture guarantee). Samples are read in their own domain (deeper integers by their depth, floats as numbers,
 * linear through sRGB's curve). {ssimulacra2}: the smallest file its search finds reaching that score under this
 * version's own metric, for 8-bit straight sRGB RGBA.
 * Default {quality: 90}.
 */
export type PixelFidelity = 'exact' | Sole<'quality'>;
export type MeasuredFidelity = Sole<'ssimulacra2'>;
export type Fidelity = PixelFidelity | MeasuredFidelity;
/** A capture's fidelity: 'exact' (the default), or every sample within maxError of the input; 0 is 'exact'. */
export type MaxError = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
/** Within each sample of the input by maxError (0-8), or exact. */
export type CaptureFidelity = 'exact' | Sole<'maxError', MaxError>;
/** One measure and no other, as the runtime refuses an object naming two. */
type FidelityKey = 'quality' | 'ssimulacra2' | 'maxError';
type Sole<K extends FidelityKey, V = number> = {[P in K]: V} & {[P in Exclude<FidelityKey, K>]?: never};
/**
 * What the samples are, on the image itself (8.0: the image says what it is, the options what to make of it). A
 * description key in the options is refused with JXL_OPTIONS. Defaults: sRGB, its own transfer curve, the depth of the
 * array (Uint8Array 8, Uint16Array 16, Float32Array float), straight alpha. An ICC profile is the one authority when
 * given. orientation (the Exif value): a lossy file carries it, an exact file is written as shown, its samples turned.
 * extraChannels need an 8-bit lossy encode (JXL_UNSUPPORTED otherwise).
 */
export interface SampleDescription {
  colorSpace?: CoreOptions['colorSpace'];
  /** The primaries and white point as a file states them, for a picture that is none of the named color spaces (what
   * `read()` from jpegxl/hdr returns); the picture's transferFunction names its curve. Instead of colorSpace, not beside it. */
  colorEncoding?: ColorEncoding;
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
/** A pixel call's handoff (encode, fit, variants, capture). */
type Handed = {
  /** true: the call takes the pixels' ArrayBuffer (an animation's frames') instead of copying it; the caller's buffer
   * is empty afterwards. A call refused leaves it as it was. A SharedArrayBuffer is refused with JXL_INPUT. */
  transfer?: true | undefined};
/** A rectangle of the picture, in whole pixels. */
export interface Region { x: number; y: number; width: number; height: number; }
/** Reads a canvas, bitmap or Blob in this space (a conversion where the source is another); pixels describe themselves. */
export type ReadAs = 'srgb' | 'display-p3';
/**
 * What the encoder should do. effort: 1 (fastest) to 9 (smallest), default 7; time for bytes at the same fidelity, the same
 * file on every host and device running this version; a later version may write different bytes for the same fidelity.
 * A lossy still at efforts 7-9 runs on WebGPU where the realm has a usable device and on WebAssembly otherwise
 * (CodecConfig.webgpu). A profile on the image is written in its smaller coding.
 * readAs: the space a canvas, bitmap or Blob is read in. A measured fidelity runs its own search over 8-bit straight
 * sRGB RGBA (the image's description must say so) and takes no codestream features other than firstRegion, and no profile.
 */
/** effort, readAs as above. webgpu: as CodecConfig.webgpu says (the call's wins over configure's). maxPixels: as
 * JobOptions says, the smaller of the call's and configure's; a larger picture refuses with JXL_DIMENSIONS before any
 * work. Above 40,000,000 pixels a measured fidelity, a lossy orientation, extra channels and features refuse JXL_UNSUPPORTED. */
type PixelEncoding = {
  /** 'exact', or {quality} from 1 to 100 (100 is exact); default {quality: 90}. */
  fidelity?: PixelFidelity};
type MeasuredEncoding = {
  /** The score to reach: {ssimulacra2}; the smallest file that reaches it. */
  fidelity: MeasuredFidelity};
type EncodingExecution = JobOptions & PreviewOptions & Described & Handed & {
  /** Encode a JPEG's decoded pixels without reconstruction data. Omitted, an unchanged JPEG is preserved for
   * 'exact'; a look request at efforts 6-9 compares reversible recompression with the pixel result. */
  jpeg?: 'pixels';
  /** 1 (fastest) to 9 (smallest file); default 7. Same fidelity, same file on every host. */
  effort?: Effort;
  /** Lossy pictures in three passes over the 1:8 image (1:4, 1:2, then the rest): a browser loading the file sharpens
   * it in steps, and jpegxl/metadata slice() cuts each size from it. The same picture in a file a few percent
   * larger. A picture the encoder codes as graphics (Modular) keeps one pass. Exact fidelity refuses JXL_OPTIONS. */
  progressive?: boolean;
  /** Space a canvas, bitmap or Blob is read in: 'srgb' or 'display-p3'; omitted, sRGB or the source's own. Pixels you pass say their own. */
  readAs?: ReadAs;
  /** Left out: use WebGPU where it helps (the result's usedWebGPU says whether it did). 'required' refuses with JXL_WEBGPU
   * any job that would run on WebAssembly: efforts 1-6, exact files, and efforts 7-9 with no usable device. false never asks for a device. */
  webgpu?: 'required' | false;
  /** The groups covering this rectangle come first in the file, so a browser loading it shows the rectangle before the
   * rest; the pixels are unchanged. Codestream settings (progressive, upsampling, ...) are format({kind: 'photo'})'s. */
  firstRegion?: Region};
export type EncodeOptions = EncodingExecution & (PixelEncoding | MeasuredEncoding);
/** {quality: max} searches from max down to 1; omitted, from 90 down to 1; a range sets both bounds. 'exact' never becomes lossy. */
export type FitFidelity = 'exact' | Sole<'quality', number | {min: number; max: number}>;
export type FitOptions = EncodingExecution & {
  /** Largest file in bytes. An unmet target resolves with meetsTarget false and no file. */
  maxBytes: number;
  /** 'exact', or {quality} as the highest quality, or {quality: {min, max}}; default searches 90 down to 1. */
  fidelity?: FitFidelity};
/** Oriented dimensions: width, height or both; a side left out keeps the picture's aspect (rounded, at least 1). Each
 * output is resampled from the original, and its result names both sides. Exact describes those samples. */
export type OutputSize = {width: number; height?: number} | {width?: number; height: number};
export type VariantRequest = OutputSize & {/** As encode's effort. */ effort?: Effort; /** As encode's progressive. */ progressive?: boolean; /** As encode's JPEG policy. */ jpeg?: 'pixels'} & (
  {/** Largest file in bytes for this output. */ maxBytes: number; /** As fit's fidelity. */ fidelity?: FitFidelity} |
  ({maxBytes?: never} & (PixelEncoding | MeasuredEncoding))
);
export type VariantsOptions = EncodeOptions & {
  /** One entry per file wanted: its size, and its own effort, fidelity, JPEG policy or maxBytes. */
  outputs: readonly VariantRequest[]};
/** jpegxl/upload's options: efforts 1-3 (default 3), 'exact' or a quality, with the full encoder's meanings. Lossy
 * float (HDR) samples, a GPU texture and firstRegion are jpegxl's: refused JXL_UNSUPPORTED. Upload runs on
 * WebAssembly: it takes no webgpu. */
export type UploadOptions = JobOptions & PreviewOptions & Described & Handed & {
  /** Encode a JPEG's decoded pixels without reconstruction data. Omitted, an unchanged 'exact' JPEG preserves the original file. */
  jpeg?: 'pixels';
  /** 'exact', or {quality} from 1 to 100 (100 is exact); default {quality: 90}. */
  fidelity?: PixelFidelity;
  /** 1 (fastest) to 3 (smallest file); default 3. */
  effort?: 1 | 2 | 3;
  /** As encode's progressive. */
  progressive?: boolean;
  /** Space a canvas, bitmap or Blob is read in: 'srgb' or 'display-p3'; omitted, sRGB or the source's own. Pixels you pass say their own. */
  readAs?: ReadAs;
  /** Most pixels the call admits; none by default. Larger refuses JXL_DIMENSIONS. */
  maxPixels?: number};
/** Frame lists are copied at the call; callers may keep them readonly. */
type Animation = Omit<CoreAnimation, 'frames'> & {frames: readonly CoreAnimation['frames'][number][]};
/** An animation describes its frames' samples as a still does, without orientation or extra channels. */
export type AnimationInput = Animation & Omit<SampleDescription, 'orientation' | 'extraChannels'> &
  {orientation?: never; extraChannels?: never};
/** An animation, {width, height, frames}: 'exact' or a quality for every frame; no measured target. */
export type AnimationOptions = JobOptions & PreviewOptions & Described & Handed & {
  /** 'exact', or {quality} from 1 to 100 for every frame; default {quality: 90}. */
  fidelity?: PixelFidelity;
  /** 1 (fastest) to 9 (smallest file); default 7. */
  effort?: Effort;
  /** Left out: use WebGPU where it helps. 'required' fails with JXL_WEBGPU without a WebGPU device, and at efforts 1-6 or exact, which run on WebAssembly. */
  webgpu?: 'required' | false};
/** A capture's effort in jpegxl/capture (1-5); jpegxl/upload takes 1-3, and
 * jpegxl/capture-complete takes every Effort, 1-9. The root still encoder has no capture() export. */
export type CaptureEffort = 1 | 2 | 3 | 4 | 5;
/** A capture runs on WebAssembly; the pixels say their colorSpace, readAs reads a canvas, bitmap or Blob in a chosen one.
 * effort: 3 by default; higher is slower and smaller, with the same pixels at the same quality, and each effort writes its
 * own file. A module refuses an effort it does not carry (JXL_UNSUPPORTED) and names the module that does; every module
 * that carries an effort writes the same file for the same call. jpegxl/capture and upload's capture run on
 * WebAssembly and take no webgpu; capture-complete's is CapturePhotoOptions.webgpu. */
export type CaptureOptions = JobOptions & PreviewOptions & Described & Handed & {
  /** 'exact' (default), or {maxError} 0 to 8: every sample within that many levels of the input. */
  fidelity?: CaptureFidelity;
  /** 1 (fastest) to 5 (smallest file); default 3. */
  effort?: CaptureEffort;
  /** Space a canvas, bitmap or Blob is read in: 'srgb' or 'display-p3'; omitted, sRGB or the source's own. Pixels you pass say their own. */
  readAs?: ReadAs};
/** Photographic capture's options (jpegxl/capture-complete, efforts 1-9; jpegxl/upload's are UploadCaptureOptions). */
/** Exact by default. A maxError is integer 0–8; quality 1–100 offers photographic capture, with 100 normalized to exact:
 * each photo gets its own coding, aimed at the measured SSIMULACRA 2 look that number names.
 * Fidelity is one exclusive choice. The picture itself continues to describe its samples. */
export type CapturePhotoFidelity = CaptureFidelity | PixelFidelity;
/** A rectangle in whole canvas pixels; width and height are positive safe integers. Parts outside the canvas are ignored. */
export type CaptureRect = {x: number; y: number; width: number; height: number};
/** solidText: the rectangle holds plain text of one color (no shadow, stroke or clipped background).
 * A box overlapping a region coded as a photo stays exact in full, including its background.
 * Elsewhere the encoder may keep only its text samples exact. */
/** edge: the rectangle holds a drawn edge (a border, an outline, a stroke); photographs code as they would without it,
 * and only flat or smooth areas keep it exact. */
export type ExactRect = CaptureRect & {solidText?: boolean; edge?: boolean};
type PhotoRect = CaptureRect & {solidText?: never; edge?: never};
/** exactRects: kept exact inside lossy photos (text whose boxes the caller knows). photoRects: pictures the caller knows
 * of (an <img>'s box); lossy only where the encoder also finds a photo there. effort: 1-9 accepted; a quality or
 * Efforts 1-5 predict the photo's look without decoder setup; efforts 6-9 measure the completed file and search for a qualifying winner. */
export type CapturePhotoOptions = Omit<CaptureOptions, 'fidelity' | 'effort'> & {
  /** 'exact' (default), {maxError} 0 to 8, or {quality} from 1 to 100 to code photos lossy. */
  fidelity?: CapturePhotoFidelity;
  /** 1 (fastest) to 9 (smallest file); default 3. Efforts 1-5 predict the look, 6-9 measure it. */
  effort?: Effort;
  /** Left out: use WebGPU where it helps. Efforts 7-9 are a capture's GPU efforts: 'required' refuses there with
   * JXL_WEBGPU where they would run on WebAssembly; false never asks for a device. Efforts 1-6 never need one. The
   * result's usedWebGPU says whether a stage ran on the device. */
  webgpu?: 'required' | false;
  /** Rectangles kept exact inside lossy photos; text boxes the caller knows. */
  exactRects?: ReadonlyArray<ExactRect>;
  /** Rectangles the caller knows are pictures; coded lossy only where the encoder also finds a photo. */
  photoRects?: ReadonlyArray<PhotoRect>;
  /** Set by page-rects with its record: exactRects covers all the page's text, even when empty. */
  readonly textComplete?: true;
  /** The same canvas drawn again with its text transparent: where the two differ is text, kept exact; the rest of a
   * solidText box over a photo is coded with the photo. rects: the boxes whose text was made transparent for certain. */
  withoutText?: CapturePixels & {rects?: ReadonlyArray<CaptureRect>};
};
/** jpegxl/upload's capture: efforts 1-3, as its encode. */
export type UploadCaptureOptions = Omit<CapturePhotoOptions, 'effort' | 'webgpu'> & {
  /** 1 (fastest) to 3 (smallest file). */
  effort?: 1 | 2 | 3};
/** JPEG recompression runs on WebAssembly. */
export interface JPEGOptions extends JobOptions {
  /** 1 (fastest) to 9 (smallest file); default 7, as encode's. */
  effort?: Effort;
}
/** The decoder's work counters stay internal at their defaults; a lowered maxTotalSamples also caps the samples held at once. */
type DecodeInternals = 'maxSamples' | 'maxRetainedSamples' | 'maxModularWork' | 'maxFeatureBytes' | 'maxFeatureWork';
/** What decode takes: output format, color space, orientation, region and the like, with the limits and JobOptions. */
export type DecodeOptions = Omit<CoreDecodeOptions, DecodeInternals> & JobOptions;
/** details: 'metadata' (Exif, XMP, JUMBF) and 'layout' (the container: boxes, fragments, the codestream). None by
 * default: the header alone, no metadata inflated, no copy of the codestream. */
export type InspectOptions = Pick<CoreDecodeOptions, 'maxPixels' | 'maxDimension' | 'maxMetadataBytes' | 'maxInputBytes' | 'maxBoxes'> &
  {/** 'metadata' reads Exif, XMP and JUMBF; 'layout' reads the container's boxes and codestream. None by default. */
    details?: readonly ('metadata' | 'layout')[];
    /** A Brotli decoder for compressed metadata the built-in reader does not take; with details metadata. */
    decompress?: BrotliCodec | undefined};
/** What inspect reads with no pixel decoded: the image header, and each detail asked for. A field absent because it was
 * not asked for says nothing about the file. `reconstruction`: a JPEG reconstruction box was among the bytes read. It
 * does not prove restore will succeed, and false on a file's first bytes says nothing; restore decides. */
export type ImageInfo = Omit<ImageHeader, 'icc'> & {metadata?: Metadata; layout?: ContainerInspection};
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
  /** Tick rate in ticks per second (numerator / denominator); 0 loops repeats forever. */
  animation: {numerator: number; denominator: number; loops: number; timecodes: boolean} | null;
  bitDepth: HeaderBitDepth;
  extraChannels: ExtraChannelInfo[];
  colorEncoding: ColorEncoding;
  /** HDR tone mapping: intensityTarget and minNits in nits (cd/m^2); linearBelow in nits when relativeToMaxDisplay is false, or 0..1 fraction of intensityTarget when true. */
  toneMapping: {intensityTarget: number; minNits: number; relativeToMaxDisplay: boolean; linearBelow: number};
  reconstruction: boolean;
  /** decode's header only: the file's own ICC profile, whatever space the samples were decoded to. header() and inspect()
   * read no profile. */
  icc?: Uint8Array;
}
/** The header alone, read synchronously (jpegxl/metadata header): no metadata is read, so no maxMetadataBytes. */
export type HeaderOptions = Omit<InspectOptions, 'details' | 'decompress' | 'maxMetadataBytes'>;
/** edit's changes: the metadata (exif, xmp, jumb; null removes, undefined keeps; compression) first, then the
 * container's framing (chunkSize, fragmentOrder, ...); the codestream and every other box stay exact. Caller metadata
 * payloads use plain Uint8Array; SharedArrayBuffer backing is refused at runtime with JXL_INPUT. */
type Edits = Pick<CompressedMetadataOptions, 'compression'> &
  {compress?: BrotliCodec | undefined; exif?: Uint8Array | null; xmp?: string | Uint8Array | null; jumb?: Uint8Array | readonly Uint8Array[] | null} &
  Pick<ReframeOptions, 'chunkSize' | 'fragmentOrder' | 'minorVersion' | 'frameStarts' | 'allowBufferedFrameEnds' | 'iccBitLength' | 'extended' | 'level'>;
/** At least one defined edit is required; input limits alone request no change. */
export type EditChanges = {[K in keyof Edits]-?: Edits & {[P in K]-?: Exclude<Edits[P], undefined>}}[keyof Edits] &
  {maxInputBytes?: number; maxBoxes?: number};
/** decode()'s result, with what its RGBA samples are in encode's words, so it goes straight back into encode. `icc` is
 * the file's own profile; rgbaICC is the one that describes `data`. colorSpace and transferFunction are absent when the
 * encoding has no name encode knows, or when rgbaICC describes the samples. Changing one of these fields and passing the
 * result to encode is refused (JXL_INPUT): retag by passing {data, width, height, ...description}. */
/** Decoded samples: 8-bit as a Uint8ClampedArray (what ImageData takes), 16-bit as Uint16Array, float as Float32Array. */
export type DecodedSamples = Uint8ClampedArray<ArrayBuffer> | Uint16Array<ArrayBuffer> | Float32Array<ArrayBuffer>;
type Clamped<T> = Omit<T, 'data' | 'colorEncoding' | 'rgbaColorEncoding'> & {data: DecodedSamples; colorEncoding: ColorEncoding; rgbaColorEncoding: ColorEncoding};
/** `header` is the whole file's image header, as decode parsed it: header()'s fields for the same file, plus `icc`, the
 * file's own profile (header() reads no profile and may read only the file's first bytes). `metadata` (Exif, XMP,
 * JUMBF) is inspect's detail, as everywhere. */
export type DecodedImage = Omit<CoreDecodedImage, 'data' | 'frames' | 'preview' | 'metadata' | 'colorEncoding' | 'rgbaColorEncoding'> & {data: DecodedSamples;
  colorEncoding: ColorEncoding; rgbaColorEncoding: ColorEncoding; header: ImageHeader;
  frames: Clamped<CoreDecodedImage['frames'][number]>[]; preview: Clamped<NonNullable<CoreDecodedImage['preview']>> | null;
  bitDepth: 8 | 16 | 32; sampleFormat: 'uint' | 'float32'; colorSpace?: ColorSpace; transferFunction?: CoreOptions['transferFunction']};
/** decode()'s result for the format asked: 'uint8' gives a Uint8ClampedArray, 'uint16' a Uint16Array, 'float32' a
 * Float32Array; 'auto' or no format, any of the three. */
export type DecodedImageOf<F> = F extends 'uint8' ? DecodedImage & {format: 'uint8'; data: Uint8ClampedArray<ArrayBuffer>}
  : F extends 'uint16' ? DecodedImage & {format: 'uint16'; data: Uint16Array<ArrayBuffer>}
  : F extends 'float32' ? DecodedImage & {format: 'float32'; data: Float32Array<ArrayBuffer>} : DecodedImage;
/**
 * The code every refusal carries, by what the caller does next. The call: JXL_OPTIONS (an option is unknown or its value is
 * not allowed). The input: JXL_INPUT (the picture or bytes are missing, empty, not what the call takes, or a file that changed while it was read), JXL_DIMENSIONS
 * (the picture is over maxPixels or the side limit), JXL_JPEG (the bytes are not a JPEG), JXL_DECODE (the file is not a valid
 * JPEG XL), JXL_RECONSTRUCTION (no JPEG reconstruction data), JXL_TARGET (a measured fidelity this version cannot reach),
 * JXL_PLATFORM (an input this realm cannot decode, or a host API this call needs; a missing decoder's message names
 * configureDecoder or the effort that runs here). A bound: JXL_MEMORY (not enough
 * memory for this picture here, or the queue's maxPendingBytes, maxPendingJobs), JXL_LIMIT (a parser's maxInputBytes or
 * maxBytes, a written file over its byte bound, or capture's rectangle budget). The host: JXL_WASM (no
 * WebAssembly with SIMD here), JXL_WEBGPU (webgpu: 'required' and a job this version would run on WebAssembly: efforts 1-6, an
 * exact file, no usable device, a device that failed the job, or a route this version runs on WebAssembly only),
 * JXL_WORKER (the worker could not start, stopped or failed; its message names the fix: a blocked worker-src, a start
 * that timed out), JXL_IO (a Blob or an image request could not be read). The lifecycle: JXL_CLOSED (the module's queue is
 * closed); a job canceled through its signal rejects with that signal's reason, an AbortError DOMException unless you
 * passed one. Not done by this version: JXL_UNSUPPORTED, a valid request or file asking for
 * something this version does not do. The setup commands: JXL_SETUP (`add` or `remove` cannot change a project's files
 * safely; its message names the step to do by hand). Ours: JXL_INTERNAL (a fault in jpegxl itself). A code keeps its meaning through 8.x; a later 8.x may add one.
 */
export type ErrorCode =
  | 'JXL_OPTIONS' | 'JXL_INPUT' | 'JXL_DIMENSIONS' | 'JXL_JPEG' | 'JXL_DECODE' | 'JXL_RECONSTRUCTION' | 'JXL_TARGET' | 'JXL_PLATFORM'
  | 'JXL_MEMORY' | 'JXL_LIMIT' | 'JXL_WASM' | 'JXL_WEBGPU' | 'JXL_WORKER'
  | 'JXL_IO' | 'JXL_CLOSED' | 'JXL_UNSUPPORTED' | 'JXL_INTERNAL' | 'JXL_SETUP';
export interface CodecError extends Error { readonly code: ErrorCode; }
export type {Animation, FormatRequest, FormatOptions};
/** A worker a module's queue talks to: a browser or Deno Worker (addEventListener with removeEventListener), or Node's
 * worker_threads Worker (on with off). */
export type WorkerLike = {
  /** The transport supplies ArrayBuffer, MessagePort, ImageBitmap or VideoFrame values. Hosts use different native
   * transferable types; the adapter keeps their postMessage signatures assignable and directly forwardable. */
  postMessage(message: unknown, transfer?: any[]): void;
  /** close() waits for a returned promise or thenable; its fulfillment value is ignored. */
  terminate(): void | PromiseLike<unknown>;
} & ({
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
} | {
  on(type: string, listener: (...args: any[]) => void): unknown;
  off(type: string, listener: (...args: any[]) => void): unknown;
});
/** A module's settings. When it runs in place it accepts the same keys and validates the queue settings.
 * maxPendingJobs bounds calls pending at once. No worker starts and no input is copied for a queue, so
 * workerFactory, workerStartupTimeout and maxPendingBytes have no effect there. */
export interface CodecConfig {
  /** Returns a fresh worker running this module's own file as its worker each time it is called: in a browser
   * `new Worker(url, {type: 'module', name: '<module> worker'})` (such as `'rapier-jxl/upload worker'`), in Node a worker
   * thread with that name as its workerData. The queue owns it: it may end it and start another (when a job running on
   * it is canceled, or the worker stops), and ends the last on close(). */
  workerFactory?: (() => WorkerLike) | undefined;
  workerStartupTimeout?: number;
  /** A job is pending from acceptance until its resources are released, queued or running; a canceled running job has
   * rejected but stays pending until its work lets go of them. The pending jobs' retained input and options together,
   * in bytes (a quarter of navigator.deviceMemory in a browser, 1 GB where it does not say, else no bound); a job past it refuses
   * JXL_MEMORY. It counts input and
   * options only, not the work's memory, and is not a promise that a host holds them. */
  maxPendingBytes?: number;
  /** The largest picture any operation admits, restore included; none by default. A side is at most 2^30. A picture's
   * pixels still count against maxPendingBytes. */
  maxPixels?: number;
  /** Pending jobs, queued or running, at once; one more refuses JXL_MEMORY. */
  maxPendingJobs?: number;
  /**
   * Helper workers granted only from this reservation: at most `count` helpers (0 or more) inside `memoryBytes`, the queue's
   * until close(): prepare() may start them before a job, and one that ends is replaced. None by default; the CPU count
   * grants nothing.
   * The bytes are the same with any number of helpers. `true` sizes them by the device: one fewer than its cores, 96 MiB
   * each within a sixteenth of a phone's memory (an eighth of a computer's; two helpers where the browser does not say).
   * In place, changing or removing this reservation with configure() retires its previous helpers. Calls still take
   * their input at the call; new helper work and successful completion wait for retirement. close() joins it too,
   * and a failed retirement rejects with JXL_WORKER. An operation's own failure keeps its original value.
   */
  helpers?: true | { count: 0; memoryBytes?: number } | { count: number; memoryBytes: number };
  /**
   * Left out: use it where it helps. A lossy still at efforts 7-9 runs on WebGPU where this realm has a usable device
   * (from the size this version measured it faster) and on WebAssembly otherwise: the same file, more slowly. The
   * result's usedWebGPU says whether a stage ran on the device.
   * 'required': the GPU, at any size, or a refusal (JXL_WEBGPU) for a lossy job at efforts 7-9 that this queue would
   * otherwise run on WebAssembly: no WebGPU adapter; a device that will not open or fails during the job; a route the
   * call chooses that this version runs on WebAssembly only (an animation, a measured fidelity, codestream features,
   * an ICC profile, deeper or HDR samples, premultiplied alpha, a color space other than sRGB). Which coding a picture's
   * content selects (a screen, a palette) never refuses. prepare('encode') refuses without an adapter.
   * Efforts 1-6 and exact files run on WebAssembly, so 'required' refuses them (JXL_WEBGPU) whatever the device.
   * false: never ask for a device.
   */
  webgpu?: 'required' | false;
}

/** A host's JPEG XL decoder for measured capture where no browser decodes JPEG XL: jpegxl/decode's decode, or any
 * function answering the whole file in the asked color space, straight alpha. An sRGB file is asked for floats (straight RGB
 * or RGBA, 0 to 1); a decoder that gives none throws an error with code 'JXL_UNSUPPORTED' and is asked for 8-bit RGBA.
 * Hooks receive owned bytes and supplied options. */
type CapturePicture = {data: Uint8Array | Uint8ClampedArray | Float32Array, width: number, height: number};
/** (bytes, {colorSpace, format, signal}) returning 8-bit RGBA, or floats where format is 'float32', with width and height. */
export type CaptureDecoder = (bytes: Bytes, options: {colorSpace: 'srgb' | 'display-p3', format: 'uint8' | 'float32', signal?: AbortSignal}) =>
  CapturePicture | PromiseLike<CapturePicture>;
/** A full decoded description; configureDecoder accepts jpegxl/decode's decode as it is. */
export type PackageDecode = (input: Bytes, options: DecodeOptions) => DecodedImage | PromiseLike<DecodedImage>;
/** jpegxl/jpeg's restore: the JPEG a recompressed file holds. */
type RestoredJPEG = Uint8Array | {bytes: Uint8Array} | import('./result.mjs').ImageResult;
export type JpegRestore = (file: Bytes, options: {maxPixels?: number, signal?: AbortSignal}) => RestoredJPEG | PromiseLike<RestoredJPEG>;
/** jpegxl/jpeg's recompress: how an encoder reads a JPEG where the host has none (Node, Deno, Bun). */
export type JpegRecompress = (file: Bytes, options: {effort?: Effort, maxPixels?: number, signal?: AbortSignal}) => {bytes: Uint8Array | null} | PromiseLike<{bytes: Uint8Array | null}>;
