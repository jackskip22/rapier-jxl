import type {ImageInput, EncodeOptions, Bytes, EncoderConfig, Encoder} from './types.mjs';
export type * from './types.mjs';
export function encode(input: ImageInput, options?: EncodeOptions): Promise<Bytes>;
export function createEncoder(config?: EncoderConfig): Encoder;
