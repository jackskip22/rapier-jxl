import type {PackageDecode, JpegRestore, JpegRecompress} from './types.mjs';
import type {Pixels, JobOptions, Effort, Animation, PixelFidelity, SampleDescription} from './types.mjs';
import type {PlanarImage, ChannelOptions} from './codec/channels.mjs';
import type {LayeredImage, LayerOptions} from './codec/layers.mjs';
import type {PatchComposition, PatchOptions, PatchCompositionOptions} from './codec/patches.mjs';
import type {SplineOptions} from './codec/splines.mjs';
import type {GraphicsOptions} from './codec/graphics.mjs';
import type {HybridOptions} from './codec/hybrid.mjs';
import type {DeltaPaletteOptions} from './codec/delta-palette.mjs';
import type {AdvancedPhotoOptions} from './codec/photo-advanced.mjs';
import type {ProfileOptions} from './codec/icc.mjs';
import type {AnimationAtlasOptions} from './codec/animation-atlas.mjs';
import type {CodecConfig} from './types.mjs';
/** Authored byte-pixel routes require straight RGBA8 with an sRGB transfer, not a deeper image description.
 * Orientation and channel support are checked separately by each kind. */
type ByteDescription = {
  colorSpace?: 'srgb' | 'display-p3';
  transferFunction?: 'srgb';
  bitDepth?: 8;
  sampleFormat?: 'uint';
  intensityTarget?: 255;
  alphaPremultiplied?: false;
  icc?: never;
};
type BytePixels = Omit<Pixels, 'data' | 'extraChannels' | keyof ByteDescription> & ByteDescription & {
  data: Uint8Array | Uint8ClampedArray; extraChannels?: readonly [];
};
/** Splines use an sRGB base; the other byte routes can also use Display P3. */
type SplinePixels = Omit<BytePixels, 'colorSpace'> & {colorSpace?: 'srgb'};
/** Hybrid admits no extraChannels key at all, not even an empty list. */
type HybridPixels = Omit<BytePixels, 'extraChannels'> & {extraChannels?: never};
/** These authored routes have no Exif orientation field. */
type UnorientedBytePixels = Omit<BytePixels, 'orientation'> & {orientation?: 1};
type ProfilePixels = Omit<Pixels, 'orientation' | 'extraChannels'> & {orientation?: 1; extraChannels?: readonly []};
/** What format() authors: a kind, and the picture or structure for it. */
export type FormatRequest =
  {kind: 'channels'; image: PlanarImage} | {kind: 'layers'; image: LayeredImage} |
  {kind: 'patch-composition'; image: PatchComposition} | {kind: 'atlas'; image: Animation} |
  ({kind: 'patches'} & BytePixels) | ({kind: 'splines'} & SplinePixels) | ({kind: 'graphics'} & UnorientedBytePixels) |
  ({kind: 'hybrid'} & HybridPixels) | ({kind: 'palette'} & UnorientedBytePixels) |
  ({kind: 'photo'} & Pixels) | ({kind: 'profile'} & ProfilePixels);
type ExactKind = 'channels' | 'layers' | 'patch-composition' | 'patches' | 'graphics' | 'palette';
type KindFidelity<K extends FormatKind> = K extends ExactKind ? 'exact' | (Exclude<PixelFidelity, 'exact'> & {quality: 100}) :
  K extends 'splines' ? Exclude<PixelFidelity, 'exact'> : PixelFidelity;
/** One kind's own options with encode's fidelity and effort. */
export type FormatOptions<K extends FormatKind = FormatKind> = K extends unknown ?
  JobOptions & {effort?: Effort; fidelity?: KindFidelity<K>} &
  Omit<KindOptions[K], EncoderSet | (K extends PixelKind ? keyof SampleDescription : never)> &
  {[P in EncoderSet | (K extends PixelKind ? keyof SampleDescription : never)]?: never} : never;
// FormatOptions: each kind's own options, with encode's one fidelity, 'exact' or {quality} (without it each kind keeps its
// default), and one effort, which also sets the screen search of graphics and palette. Channels, layers, patch
// compositions, patches, graphics and palettes take exact or quality 100; graphics presets and baseError are their
// explicit loss controls. Splines require quality below 100. A picture's description
// (colorSpace, icc, bitDepth, orientation, ...) is on the request, never in its options. fidelity 'exact' with a control
// that allows loss (a preset other than exact, maxColorError or baseError above zero, undither) is refused.
// A fact a kind's file cannot hold is refused JXL_UNSUPPORTED, never dropped: orientation in graphics, palette, profile
// and an exact photo or one not eight-bit with sRGB transfer; extra channels in every pixel kind but photo, and in an exact
// photo: kind 'channels' is the one way to keep every sample of a picture with extra channels.
// A kind's own option out of its range (groupSize: 7) is refused JXL_INPUT, with the structure it shapes; an unknown
// option, effort, fidelity and JobOptions refuse JXL_OPTIONS, as in encode.
/** The kinds of file format() authors: channels, layers, patch-composition, patches, atlas, splines, graphics, hybrid, palette, photo, profile. */
export type FormatKind = FormatRequest['kind'];
type PixelKind = 'patches' | 'splines' | 'graphics' | 'hybrid' | 'palette' | 'photo' | 'profile';
interface KindOptions {
  channels: ChannelOptions; layers: LayerOptions; 'patch-composition': PatchCompositionOptions; atlas: AnimationAtlasOptions;
  patches: PatchOptions; splines: SplineOptions; graphics: GraphicsOptions; hybrid: HybridOptions; palette: DeltaPaletteOptions;
  photo: AdvancedPhotoOptions; profile: ProfileOptions;
}
// What the kinds' modules read that format() sets itself (fidelity, effort and the coding): never an option.
type EncoderSet = 'quality' | 'lossless' | 'target' | 'maxError' | 'photo' | 'filter' | 'losslessProfile' | 'mode' | 'acceleration' | 'progress' | 'screenEffort';
export {encode, supported} from './index.mjs';
/** Compiles the authored routes' kernels ('format', the default), or prepares the shared still encoder.
 * Any other preparation operation refuses JXL_OPTIONS. */
export function prepare(operation?: 'format' | 'encode'): Promise<void>;
/** An authored structure (layers, patches, splines, extra channels, palettes, profiles, atlases): the request names its
 * kind. The full still encoder rides in the same file: a page's calls run in its own worker; calls in a worker, Node and edge hosts run in place. */
type FormatCall = {[K in FormatKind]: [input: Extract<FormatRequest, {kind: K}>,
  ...options: {} extends FormatOptions<K> ? [options?: FormatOptions<K>] : [options: FormatOptions<K>]]}[FormatKind];
export function format(...args: FormatCall): Promise<import('./result.mjs').EncodedResult>;

/** Where the host reads no JPEG (Node, Deno, Bun), the one setup step for a JPEG input: `configureDecoder(decode, restore,
 * recompress)` with rapier-jxl/decode's decode and rapier-jxl/jpeg's recompress (restore may be null). Without it a JPEG
 * refuses JXL_PLATFORM. One call serves every rapier-jxl module in the realm; null alone clears it, while null with helpers keeps them. */
export function configureDecoder(decode: PackageDecode | null, restore?: JpegRestore | null, recompress?: JpegRecompress | null): void;
export type {ImageJob, ImageVerb, Digest, ResultSource, ResultReason, ResultTransform, ResultFidelity, ResultMeasurement, ImageResult, EncodedResult} from './result.mjs';

/** This module's settings for the calls that follow. In a browser they are its queue's: the module runs in its own file's
 * worker, from a page or nested in a worker of the page's own; configure before the first call, or again once close() has
 * resolved. In place (Node, Deno, Bun, edge hosts, a page's own worker) it takes the same
 * keys: helpers (where the module has them), webgpu and maxPixels, and maxPendingJobs bounding the calls pending at once; no worker starts and nothing is copied
 * there, so the worker settings and maxPendingBytes have nothing to act on. Configuring while a call runs refuses JXL_OPTIONS. */
export function configure(settings?: CodecConfig): void;
/** Ends this module's worker and helpers; the next call starts them again. */
export function close(): Promise<void>;

/** Every refusal: a coded Error. */
export type {CodecError, ErrorCode} from './types.mjs';
