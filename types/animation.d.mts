import type {ImageInput, EncodeOptions, AnimationInput, AnimationOptions, Bytes} from './types.mjs';
export type * from './types.mjs';
export {capture, prepare, supported, configureWasm} from './index.mjs';
/** An animation ({width, height, frames}) or a still: the full still encoder carries both, one file in place. */
export function encode(input: AnimationInput, options?: AnimationOptions): Promise<Bytes>;
export function encode(input: ImageInput, options?: EncodeOptions): Promise<Bytes>;
