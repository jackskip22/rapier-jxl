import type {DecodeOptions, DecodedImage} from './types.mjs';
export type * from './codec/decode.mjs';
export function decode(input: Uint8Array | Blob, options?: DecodeOptions): Promise<DecodedImage>;
export function inspect(input: Uint8Array, options?: Pick<DecodeOptions, 'maxPixels' | 'maxDimension' | 'maxSamples' | 'maxMetadataBytes' | 'maxInputBytes'>): Promise<DecodedImage['metadata']>;
