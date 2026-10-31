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
export type FormatRequest =
  {kind: 'channels'; image: PlanarImage} | {kind: 'layers'; image: LayeredImage} |
  {kind: 'patch-composition'; image: PatchComposition} | {kind: 'atlas'; image: Animation} |
  ({kind: 'patches' | 'splines' | 'graphics' | 'hybrid' | 'palette' | 'photo' | 'profile'} & Pixels);
export type FormatOptions<K extends FormatKind = FormatKind> = JobOptions & {effort?: Effort; fidelity?: PixelFidelity} &
  (K extends unknown ? Omit<KindOptions[K], Retired | 'screenEffort' | (K extends PixelKind ? keyof SampleDescription : never)> : never);
// FormatOptions: each kind's own options, with encode's one fidelity, 'exact' or {quality} (without it each kind keeps its
// default), and one effort, which also sets the screen search of graphics and palette. A picture's description
// (colorSpace, icc, bitDepth, orientation, ...) is on the request, never in its options. fidelity 'exact' with a control
// that allows loss (a preset other than exact, maxColorError or baseError above zero, undither) is refused.
// A fact a kind's file cannot hold is refused JXL_UNSUPPORTED, never dropped: orientation in graphics, palette, profile
// and an exact photo or one not eight-bit with sRGB transfer; extra channels in every pixel kind but photo.
export type FormatKind = FormatRequest['kind'];
type PixelKind = 'patches' | 'splines' | 'graphics' | 'hybrid' | 'palette' | 'photo' | 'profile';
interface KindOptions {
  channels: ChannelOptions; layers: LayerOptions; 'patch-composition': PatchCompositionOptions; atlas: AnimationAtlasOptions;
  patches: PatchOptions; splines: SplineOptions; graphics: GraphicsOptions; hybrid: HybridOptions; palette: DeltaPaletteOptions;
  photo: AdvancedPhotoOptions; profile: ProfileOptions;
}
// The 7.x spellings of fidelity and the coder switches the encoder chooses itself are not among them.
type Retired = 'quality' | 'lossless' | 'target' | 'maxError' | 'photo' | 'filter' | 'losslessProfile' | 'mode' | 'acceleration';
export {encode, capture, supported, configureWasm} from './index.mjs';
/** The kernels the authored routes run on ('format', the default), or rapier-jxl's 'encode' or 'capture', with no job. */
export function prepare(operation?: 'format' | 'encode' | 'capture'): Promise<void>;
/** An authored structure (layers, patches, splines, extra channels, palettes, profiles, atlases): the request names its
 * kind. The full still encoder rides in the same file. */
export function format<R extends FormatRequest>(input: R, options?: FormatOptions<R['kind']>): Promise<import('./types.mjs').Bytes>;
