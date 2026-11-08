import type {ImageResult} from './result.mjs';
import type {ImageInput, EncodeOptions, AnimationInput, AnimationOptions} from './types.mjs';
export type * from './types.mjs';
export {supported, configureWasm} from './index.mjs';
/** Compiles the kernels used by still and animation encoding. */
export function prepare(operation?: 'encode'): Promise<void>;
/** An animation ({width, height, frames}) or a still: the full still encoder carries both, one file in place. */
export function encode(input: AnimationInput, options?: AnimationOptions): Promise<ImageResult>;
export function encode(input: ImageInput, options?: EncodeOptions): Promise<ImageResult>;

export {resultJSON} from './result.mjs';
