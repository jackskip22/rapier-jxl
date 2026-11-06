import type {EncodeOptions as CoreOptions, ColorSpace} from './codec/index.mjs';
import type {AdvancedPhotoOptions} from './codec/photo-advanced.mjs';
import type {DecodedImage as CoreDecodedImage, DecodeOptions as CoreDecodeOptions} from './codec/decode.mjs';
import type {Metadata, CompressedMetadataOptions, BrotliCodec as CoreBrotliCodec} from './codec/metadata.mjs';
import type {ContainerInspection, ReframeOptions} from './codec/container-advanced.mjs';
import type {Animation as CoreAnimation} from './codec/animation.mjs';
import type {FormatRequest, FormatOptions} from './format.mjs';
export type {ImageJob, ImageVerb, Digest, ResultSource, ResultReason, ResultTransform, ResultFidelity, ResultMeasurement, ImageResult, ImageResultJSON} from './result.mjs';

/** Half floats as a Float16Array holds them (typed here by its shape: TypeScript's lib has the global only in esnext).
 * Read as sampleFormat 'float16', as a Uint16Array of their bits with sampleFormat 'float16' is. */
export interface Float16Samples extends ArrayBufferView { readonly [Symbol.toStringTag]: 'Float16Array'; readonly length: number; [index: number]: number; }
export type Samples = Uint8Array | Uint8ClampedArray | Uint16Array | Float16Samples | Float32Array;
/** Library-produced bytes own an ArrayBuffer; caller byte inputs accept plain Uint8Array. */
export type Bytes = Uint8Array<ArrayBuffer>;
/** Metadata callbacks receive owned bytes and may return bytes immediately or through any thenable. */
type BrotliCodec = (bytes: Bytes, options: Parameters<CoreBrotliCodec>[1]) => Uint8Array | PromiseLike<Uint8Array>;
export type Effort = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
/** Pixels describe themselves: what the samples are travels with them (SampleDescription). */
export interface Pixels extends SampleDescription { data: Samples; width: number; height: number; }
export interface CanvasSurface {
  readonly width: number; readonly height: number;
  getContext(contextId: '2d', options?: {willReadFrequently?: boolean}): unknown;
}
export interface BitmapSurface { readonly width: number; readonly height: number; close(): void; }
/** A WebCodecs VideoFrame (a camera, a screen capture, a decoded video): read at its display size, converted by the
 * browser from its own color space to sRGB, or to readAs. The caller keeps it and closes it. */
export interface FrameSurface { readonly displayWidth: number; readonly displayHeight: number; close(): void; }
/** decode()'s result is an input too: its description says what its samples are. A canvas (2D, WebGL or WebGPU),
 * bitmap, video frame or Blob is read in sRGB, or its own space, unless the options' readAs names one. Through a codec
 * whose jobs run in a worker, a canvas, bitmap or video frame is taken as a snapshot at the call and read there. */
/** A <video> (playing, or paused on a frame): read as the frame it shows, as a VideoFrame of it is. Refused JXL_INPUT
 * before it has a frame (readyState below 2) or when the browser will not read it (cross-origin without CORS). */
export interface VideoSurface { readonly videoWidth: number; readonly videoHeight: number; readonly readyState: number; }
export type ImageInput = Pixels | DecodedImage | CanvasSurface | BitmapSurface | FrameSurface | VideoSurface | Blob | RowSource | TextureInput;
/** Upload keeps the universal image inputs except GPU textures, which the full encoder reads. */
export type UploadInput = Exclude<ImageInput, TextureInput>;
/** A capture reads 8-bit straight RGBA in sRGB or Display P3: pixels it is given are 8-bit (encode takes deeper ones). */
export interface CapturePixels extends Pixels { data: Uint8Array | Uint8ClampedArray; }
/** A capture's supplied pixels and row bands are 8-bit. */
export type CaptureInput = Exclude<ImageInput, Pixels | DecodedImage | RowSource> | CapturePixels | DecodedImage | CaptureRowSource;
/** Upload's capture: its inputs, with pixels the caller makes 8-bit. */
export type UploadCaptureInput = Exclude<CaptureInput, TextureInput>;
/** Preparation owns one still image, at most 40,000,000 pixels. Streamed rows are encoded directly. */
export type PreparationInput = Exclude<ImageInput, RowSource>;
/** A WebGPU texture (2D, one sample, COPY_SRC usage; rgba8unorm, bgra8unorm, their -srgb forms, rgba16float or
 * rgba32float), read from mip level 0 and its `layer` in the realm of its device: the copy is submitted at the call, so GPU work
 * submitted later does not reach the file. A texture carries no color meaning: the description says it; unsaid, 8-bit
 * formats are sRGB and float formats linear sRGB. Through a worker codec it is read in the page, then queued. */
export interface GPUTextureLike {readonly width: number; readonly height: number; readonly format: string; readonly usage: number; readonly dimension: string; readonly sampleCount: number; readonly depthOrArrayLayers?: number}
/** An extra channel read from a texture of the input's device (a depth buffer: depth16unorm, depth32float, r16uint,
 * r16float or r32float), from the input's layer, at the picture's size or its 2^dimShift reduction. */
export type TextureChannel = Omit<NonNullable<AdvancedPhotoOptions['extraChannels']>[number], 'data' | 'bitDepth' | 'sampleFormat' | 'exponentBits'> & {texture: GPUTextureLike; data?: never};
export interface TextureInput extends Omit<SampleDescription, 'extraChannels'> {
  texture: GPUTextureLike;
  device: {readonly queue: unknown; createBuffer(descriptor: object): unknown; createCommandEncoder(): unknown};
  /** The array layer read: a WebXR projection layer holds one eye per layer. Default 0. */
  layer?: number;
  extraChannels?: readonly ((NonNullable<AdvancedPhotoOptions['extraChannels']>[number] & {texture?: never}) | TextureChannel)[];
}
/** A picture given a band of rows at a time, so it is never whole in memory: rows(y, count) returns rows y to
 * y + count - 1 as {data} (width x count RGBA samples, described by the source) or a canvas, bitmap or video frame of
 * width x count (8-bit, in the source's colorSpace: sRGB or Display P3). Bands are asked for top to bottom and may be
 * asked for again; each is copied as it arrives, so its buffer may be reused. Coded in bands of about 4 MP. Through a
 * worker codec the page answers the worker's asks. No readAs, orientation, extra channels, measured fidelity or features. */
export interface RowSource extends Omit<SampleDescription, 'orientation' | 'extraChannels'> {
  width: number; height: number;
  orientation?: never; extraChannels?: never;
  rows(y: number, count: number): RowBand | PromiseLike<RowBand>;
}
export type RowBand = {data: Samples} | CanvasSurface | BitmapSurface | FrameSurface;
/** Capture row bands supply 8-bit pixels or a native surface. */
export type CaptureRowBand = {data: CapturePixels['data']} | CanvasSurface | BitmapSurface | FrameSurface;
export interface CaptureRowSource extends RowSource {
  rows(y: number, count: number): CaptureRowBand | PromiseLike<CaptureRowBand>;
}
/** signal: aborting rejects the job with the signal's reason. onProgress: 0 once started, rising to 1 before the result;
 * an onProgress that throws cancels the job, which rejects with what it threw. */
/** maxPixels: the largest picture this call admits, default 40,000,000; under a codec the smaller of the two holds. An
 * encode or capture takes up to 268,435,456 pixels (32,767 a side): above 40,000,000 the picture is coded in bands of
 * about 4 MP, composed as one still, so working memory stays about one band's beside the input. Decode has its own
 * dimension and work bounds. A JPEG's recompress and restore: up to 64,000,000, the default, and 16,384 a side.
 * Preparation calls take at most 40,000,000. */
export interface JobOptions { signal?: AbortSignal; onProgress?: (fraction: number) => void; maxPixels?: number; }

/**
 * The one fidelity choice; its shape is exclusive. 'exact': the decoded samples equal the input, bit for bit, in its
 * tagged color space. {quality}: 1 to 100, fractions allowed; 100 is 'exact'. The number aims at a measured SSIMULACRA 2
 * look, and the file is the smallest this version finds with that look (a prediction calibrated on measured photos, not a
 * per-picture guarantee). Samples are read in their own domain (deeper integers by their depth, floats as numbers,
 * linear through sRGB's curve). {ssimulacra2},
 * {butteraugli} (maximum) or {butteraugli3} (3-norm): the smallest file its search finds reaching that score under this
 * version's own metric, for 8-bit straight sRGB RGBA.
 * Default {quality: 90}.
 */
export type PixelFidelity = 'exact' | Sole<'quality'>;
export type MeasuredFidelity = Sole<'ssimulacra2'> | Sole<'butteraugli'> | Sole<'butteraugli3'>;
/** A still's fidelity without a search: an animation or a format request takes PixelFidelity alone. */
export type StillFidelity = PixelFidelity;
export type Fidelity = StillFidelity | MeasuredFidelity;
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
/** A rectangle of the picture, in whole pixels. */
export interface Region { x: number; y: number; width: number; height: number; }
/** firstRegion: the groups covering this rectangle come first in the file, so a browser loading it shows the rectangle
 * before the rest; the pixels are unchanged. rapier-jxl takes it; rapier-jxl/upload and a capture refuse it
 * (JXL_UNSUPPORTED) in this version. */
export interface DeliveryFeatures { firstRegion?: Region; }
/** An empty feature record asks for no codestream features. */
export type EmptyFeatures = Record<PropertyKey, never>;
/** Captures accept an inert feature record; an active firstRegion is refused with JXL_UNSUPPORTED. */
export type CaptureFeatures = {firstRegion?: undefined};
/** Codestream features an encode may set (level, upsampling, ...); `format()` authors whole structures. */
export type EncodeFeatures = Pick<AdvancedPhotoOptions, 'level' | 'upsampling' | 'upsamplingWeights' |
  'transforms' | 'quantization' | 'coefficientOrders' | 'progressive' | 'noise' | 'lfFrames'> & DeliveryFeatures;
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
/** effort, readAs as above. webgpu: as CodecConfig.webgpu says (the call's wins over a codec's). maxPixels: as
 * JobOptions says, the smaller of the call's and the codec's; a larger picture refuses with JXL_DIMENSIONS before any
 * work. Above 40,000,000 pixels a measured fidelity, orientation, extra channels and features refuse JXL_UNSUPPORTED. */
type PixelEncoding = {fidelity?: StillFidelity; features?: EncodeFeatures};
type MeasuredEncoding = {fidelity: MeasuredFidelity; features?: {firstRegion?: Region} &
  {[K in Exclude<keyof EncodeFeatures, keyof DeliveryFeatures>]?: never}};
type EncodingExecution = JobOptions & Described & {effort?: Effort; readAs?: ReadAs; webgpu?: 'required' | false};
export type EncodeOptions = EncodingExecution & (PixelEncoding | MeasuredEncoding);
/** {quality: max} searches from max down to 1; omitted, from 90 down to 1; a range sets both bounds. 'exact' never becomes lossy. */
export type FitFidelity = 'exact' | Sole<'quality', number | {min: number; max: number}>;
export type FitOptions = EncodingExecution & {maxBytes: number; fidelity?: FitFidelity; features?: EncodeFeatures};
/** Oriented dimensions: width, height or both; a side left out keeps the picture's aspect (rounded, at least 1). Each
 * output is resampled from the original, and its result names both sides. Exact describes those samples. */
export type OutputSize = {width: number; height?: number} | {width?: number; height: number};
export type VariantRequest = OutputSize & {effort?: Effort} & (
  {maxBytes: number; fidelity?: FitFidelity; features?: EncodeFeatures} |
  ({maxBytes?: never} & (PixelEncoding | MeasuredEncoding))
);
export type VariantsOptions = EncodeOptions & {outputs: readonly VariantRequest[]};
/** rapier-jxl/upload's options: efforts 1-3 (default 3), 'exact' or a quality, with the full encoder's meanings. Lossy
 * float (HDR) samples, a GPU texture and features (firstRegion included) are rapier-jxl's: refused JXL_UNSUPPORTED.
 * webgpu is taken and changes nothing: efforts 1-3 never ask for a device. */
export type UploadOptions = JobOptions & Described & {fidelity?: StillFidelity; effort?: 1 | 2 | 3; readAs?: ReadAs; features?: EmptyFeatures;
  webgpu?: 'required' | false; maxPixels?: number};
/** Frame lists are copied at the call; callers may keep them readonly. */
type Animation = Omit<CoreAnimation, 'frames'> & {frames: readonly CoreAnimation['frames'][number][]};
/** An animation describes its frames' samples as a still does, without orientation or extra channels. */
export type AnimationInput = Animation & Omit<SampleDescription, 'orientation' | 'extraChannels'> &
  {orientation?: never; extraChannels?: never};
/** An animation, {width, height, frames}: 'exact' or a quality for every frame; no measured target, no `features`. */
export type AnimationOptions = JobOptions & Described & {fidelity?: PixelFidelity; effort?: Effort; features?: EmptyFeatures;
  webgpu?: 'required' | false};
/** A capture's effort in rapier-jxl/capture (1-5); rapier-jxl/upload takes 1-3, and rapier-jxl/capture-complete and
 * rapier-jxl every Effort, 1-9. */
export type CaptureEffort = 1 | 2 | 3 | 4 | 5;
/** A capture runs on WebAssembly; the pixels say their colorSpace, readAs reads a canvas, bitmap or Blob in a chosen one.
 * effort: 3 by default; higher is slower and smaller, with the same pixels at the same quality, and each effort writes its
 * own file. A module refuses an effort it does not carry (JXL_UNSUPPORTED) and names the module that does; every module
 * that carries an effort writes the same bytes for the same call. webgpu: as CodecConfig.webgpu says; efforts 7-9 are a capture's GPU efforts, so 'required' refuses there
 * (JXL_WEBGPU) in a module or realm that runs them on WebAssembly, and nowhere below 7. */
export type CaptureOptions = JobOptions & Described & {fidelity?: CaptureFidelity; effort?: CaptureEffort; webgpu?: 'required' | false; readAs?: ReadAs; features?: CaptureFeatures;
  onEncoded?: (record: CaptureRecord) => void};
/** A capture's execution record, given to onEncoded once the file is written and before the capture resolves, also
 * through a codec. exact: every pixel decodes as it was read. bands: the horizontal bands the picture was coded in (1
 * unless it is large or read by rows). Each field reports what ran, and never changes the file. The capture can still
 * reject after it (an abort, or an onProgress that throws at 1); an onEncoded that throws cancels the capture with what
 * it threw. */
export type CaptureRecord = {readonly exact: boolean; readonly bands: number};
/** Photographic capture's options (rapier-jxl/capture-complete and the root, efforts 1-9; rapier-jxl/upload's are UploadCaptureOptions). */
/** Exact by default. A maxError is integer 0–8; quality 1–100 offers photographic capture, with 100 normalized to exact:
 * each photo gets its own coding, aimed at the measured SSIMULACRA 2 look that number names.
 * Fidelity is one exclusive choice. The picture itself continues to describe its samples. */
export type CapturePhotoFidelity = CaptureFidelity | PixelFidelity;
/** A rectangle in whole canvas pixels; width and height are positive safe integers. Parts outside the canvas are ignored. */
export type CaptureRect = {x: number; y: number; width: number; height: number};
/** solidText: the rectangle holds plain text of one colour (no shadow, stroke or clipped background); only that text
 * stays exact, and the photo under it stays a photo, where the text stands out from it. */
/** edge: the rectangle holds a drawn edge (a border, an outline, a stroke); photographs code as they would without it,
 * and only flat or smooth areas keep it exact. */
export type ExactRect = CaptureRect & {solidText?: boolean; edge?: boolean};
type PhotoRect = CaptureRect & {solidText?: never; edge?: never};
/** exactRects: kept exact inside lossy photos (text whose boxes the caller knows). photoRects: pictures the caller knows
 * of (an <img>'s box); lossy only where the encoder also finds a photo there. effort: 1-9 accepted; a quality or
 * Photographic efforts 5-6 search quality, 7 selects block shapes, 8 adds adaptive quantization, and 9 searches all candidates. */
export type CapturePhotoOptions = Omit<CaptureOptions, 'fidelity' | 'effort'> & {
  fidelity?: CapturePhotoFidelity; effort?: Effort;
  exactRects?: ReadonlyArray<ExactRect>; photoRects?: ReadonlyArray<PhotoRect>;
};
/** rapier-jxl/upload's capture: efforts 1-3, as its encode. */
export type UploadCaptureOptions = Omit<CapturePhotoOptions, 'effort'> & {effort?: 1 | 2 | 3};
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
  {details?: readonly ('metadata' | 'layout')[];
    /** A Brotli decoder for compressed metadata the built-in reader does not take; with details metadata. */
    decompress?: BrotliCodec};
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
 * container's framing (chunkSize, fragmentOrder, ...); the codestream and every other box stay exact. Caller metadata
 * payloads use plain Uint8Array; SharedArrayBuffer backing is refused at runtime with JXL_INPUT. */
type Edits = Pick<CompressedMetadataOptions, 'compression'> &
  {compress?: BrotliCodec; exif?: Uint8Array | null; xmp?: string | Uint8Array | null; jumb?: Uint8Array | readonly Uint8Array[] | null} &
  Pick<ReframeOptions, 'chunkSize' | 'fragmentOrder' | 'minorVersion' | 'frameStarts' | 'allowBufferedFrameEnds' | 'iccBitLength' | 'extended' | 'level'>;
/** At least one defined edit is required; input limits alone request no change. */
export type EditChanges = {[K in keyof Edits]-?: Edits & {[P in K]-?: Exclude<Edits[P], undefined>}}[keyof Edits] &
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
export interface CodecConfig {
  /** Returns a fresh worker running this module's worker file each time it is called. The codec owns it: it may end
   * it and start another (when a job running on it is canceled, or the worker stops), and ends the last on close(). */
  workerFactory?: () => WorkerLike;
  workerStartupTimeout?: number;
  /** A job is pending from acceptance until its resources are released, queued or running; a canceled running job has
   * rejected but stays pending until its work lets go of them. The pending jobs' retained input and options together,
   * in bytes (default 256 MiB); a job past it refuses JXL_MEMORY. */
  maxPendingBytes?: number;
  /** The largest picture any operation admits, restore included: default 40,000,000 pixels, at most 268,435,456 (an
   * encode or capture above 40,000,000 is coded in bands, and decode reopens it; a JPEG's recompress and restore take the
   * queue's value up to 64,000,000, by default 64,000,000; the other operations keep 40,000,000);
   * Encode/capture take 32,767 a side, or 16,384 for JPEG recompress and restore. A
   * picture's pixels still count against maxPendingBytes. */
  maxPixels?: number;
  /** Pending jobs, queued or running, at once; one more refuses JXL_MEMORY. */
  maxPendingJobs?: number;
  /**
   * Helper workers granted only from this reservation: at most `count` helpers (0–16) inside `memoryBytes`, the codec's
   * until close(): prepare() may start them before a job, and one that ends is replaced. None by default; the CPU count
   * grants nothing.
   * The bytes are the same with any number of helpers. `true` sizes them by the device: one fewer than its cores, 96 MiB
   * each within a sixteenth of a phone's memory (an eighth of a computer's; two helpers where the browser does not say).
   */
  helpers?: true | { count: 0; memoryBytes?: number } | { count: number; memoryBytes: number };
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

/** A host's JPEG XL decoder for measured capture where no browser decodes JPEG XL: rapier-jxl/decode's decode, or any
 * function answering 8-bit straight RGBA of the whole file in the asked color space. Hooks receive owned bytes and supplied options. */
type CapturePicture = {data: Uint8Array | Uint8ClampedArray, width: number, height: number};
export type CaptureDecoder = (bytes: Bytes, options: {colorSpace: 'srgb' | 'display-p3', format: 'uint8', signal?: AbortSignal}) =>
  CapturePicture | PromiseLike<CapturePicture>;
/** A full decoded description; configureDecoder accepts rapier-jxl/decode's decode as it is. */
export type PackageDecode = (input: Bytes, options: DecodeOptions) => DecodedImage | PromiseLike<DecodedImage>;
/** rapier-jxl/jpeg's restore: the JPEG a recompressed file holds. */
type RestoredJPEG = Uint8Array | {bytes: Uint8Array} | import('./result.mjs').ImageResult;
export type JpegRestore = (file: Bytes, options: {maxPixels?: number, signal?: AbortSignal}) => RestoredJPEG | PromiseLike<RestoredJPEG>;
