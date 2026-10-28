import type {Pixels, JobOptions, Effort, Animation, Bytes} from './types.mjs';
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
export type FormatOptions = JobOptions & {effort?: Effort} & (ChannelOptions | LayerOptions | PatchCompositionOptions |
  PatchOptions | SplineOptions | GraphicsOptions | HybridOptions | DeltaPaletteOptions | AdvancedPhotoOptions | ProfileOptions | AnimationAtlasOptions);
export function encode(input: FormatRequest, options?: FormatOptions): Promise<Bytes>;
