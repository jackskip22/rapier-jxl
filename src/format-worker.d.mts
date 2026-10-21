// SPDX-License-Identifier: MIT
import type {Pixels, Bytes} from './index.mjs';
import type {AdvancedPhotoOptions} from './photo-advanced.mjs';
import type {NoisePhotoOptions} from './photo-noise.mjs';
import type {HybridOptions, HybridRegion} from './hybrid.mjs';
import type {DeltaPaletteOptions} from './delta-palette.mjs';
import type {PatchOptions} from './patches.mjs';
import type {SplineOptions, SplineStrokeOptions, SplinePoint, QuantizedSpline} from './splines.mjs';
import type {PlanarImage, ChannelOptions} from './channels.mjs';
import type {LayeredImage, LayerOptions} from './layers.mjs';
import type {ProfileOptions} from './icc.mjs';
import type {SourceImage} from './source.mjs';
import type {ContainerOptions, ContainerStreamOptions} from './container-stream.mjs';
import type {ContainerBounds, ContainerWriteOptions, ReframeOptions, ContainerInspection, FrameIndex, GainMapBundle, ReadGainMapBundle} from './container-advanced.mjs';
import type {ProgressiveContainerOptions, ProgressiveStreamOptions, ProgressiveContainerPlan} from './progressive-container.mjs';
import type {MetadataOptions, CompressedMetadataOptions, MetadataReadOptions, Metadata} from './metadata.mjs';
import type {OpsinOptions} from './opsin.mjs';
import type {DeliveryOptions, DeliveryReadOptions, DeliveryLayout} from './delivery.mjs';
import type {PhotoPlanOptions, TargetOptions, TargetResult, PhotoPlan} from './photo-plan.mjs';
import type {BrotliOptions} from './brotli.mjs';

type PixelRequest<A extends string, O> = {action: A; data: Pixels | ArrayBuffer; width: number; height: number; options?: O};
type ByteRequest<A extends string, O = never> = {action: A; bytes: Uint8Array | ArrayBuffer; options?: O};
/** All requests are structured-cloneable. Pass cancellation and progress outside the format options.
 * Compression callbacks cannot travel in a worker message; the built-in deterministic Brotli codec is used.
 * Its reader accepts the authored subset; readMetadata preserves other compressed payloads without decoding. */
export type FormatRequest =
  | PixelRequest<'photo', AdvancedPhotoOptions>
  | PixelRequest<'noise', NoisePhotoOptions>
  | PixelRequest<'hybrid', HybridOptions>
  | PixelRequest<'hybridRegions', never>
  | PixelRequest<'deltaPalette', DeltaPaletteOptions>
  | (PixelRequest<'patches', PatchOptions> & {options: PatchOptions})
  | (PixelRequest<'splines', SplineOptions> & {options: SplineOptions})
  | {action: 'splineStroke'; controlPoints: readonly SplinePoint[]; options: SplineStrokeOptions}
  | {action: 'channels'; image: PlanarImage; options?: ChannelOptions}
  | {action: 'layers'; image: LayeredImage; options?: LayerOptions}
  | PixelRequest<'profile', ProfileOptions>
  | (PixelRequest<'photoPlan', PhotoPlanOptions> & {qualities?: readonly number[]; targetBytes?: number; targetOptions?: TargetOptions})
  | ByteRequest<'readSource'>
  | ByteRequest<'encodeSource', ProfileOptions>
  | ByteRequest<'container', Omit<ContainerOptions, 'signal'>>
  | {action: 'streamContainer'; chunks: readonly (Uint8Array | ArrayBuffer)[]; options?: Omit<ContainerStreamOptions, 'signal'>}
  | ByteRequest<'inspectContainer', ContainerBounds>
  | ByteRequest<'reframeContainer', ReframeOptions>
  | ByteRequest<'progressiveContainer', Omit<ProgressiveStreamOptions, 'signal' | 'metadata'> & {metadata?: Omit<CompressedMetadataOptions, 'compress'>}>
  | ByteRequest<'progressivePlan', Omit<ProgressiveContainerOptions, 'signal'>>
  | ByteRequest<'metadata', MetadataOptions>
  | ByteRequest<'compressedMetadata', Omit<CompressedMetadataOptions, 'compress'>>
  | ByteRequest<'readMetadata'>
  | ByteRequest<'readCompressedMetadata', Omit<MetadataReadOptions, 'decompress'>>
  | ByteRequest<'opsin', OpsinOptions>
  | (ByteRequest<'frameIndex', ContainerWriteOptions> & {index: FrameIndex | null})
  | ByteRequest<'readFrameIndex', ContainerBounds>
  | {action: 'frameIndexPayload'; index: FrameIndex; options?: ContainerBounds}
  | (ByteRequest<'gainMap', ContainerWriteOptions> & {bundle: GainMapBundle | null})
  | ByteRequest<'readGainMap', ContainerBounds>
  | {action: 'gainMapPayload'; bundle: GainMapBundle; options?: ContainerWriteOptions}
  | {action: 'boxHeader'; boxType: string; bodyByteLength: number; options?: {extended?: boolean}}
  | ByteRequest<'deliveryLayout', DeliveryReadOptions>
  | ByteRequest<'deliveryOrder', DeliveryOptions>
  | ByteRequest<'normalizeDelivery', DeliveryReadOptions>
  | ByteRequest<'brotliCompress', BrotliOptions>
  | ByteRequest<'brotliDecompress', BrotliOptions>;
/** A request reuses one plan for up to 32 qualities and one optional target, then disposes the retained buffers.
 * Output image bytes together are bounded to 16 MiB. Omitted qualities encode the planning quality unless a
 * target is supplied. Size search returns the highest tested fitting quality, not a global optimum. */
export interface FormatPhotoPlanResult extends Pick<PhotoPlan, 'width' | 'height' | 'planningQuality' | 'retainedBytes' | 'blockCount' | 'strategies'> {
  images: {quality: number; bytes: Bytes}[];
  target: TargetResult | null;
}
export type FormatResult = Bytes | HybridRegion[] | SourceImage | QuantizedSpline | ContainerInspection |
  ProgressiveContainerPlan | Metadata | FrameIndex | ReadGainMapBundle | DeliveryLayout | FormatPhotoPlanResult | null;
export const FORMAT_ACTIONS: readonly FormatRequest['action'][];
export function format(input: FormatRequest, controls?: {signal?: AbortSignal; onProgress?: (fraction: number) => void}): Promise<FormatResult>;
