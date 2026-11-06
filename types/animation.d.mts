import type {ImageResult} from './result.mjs';
import type {ImageInput, EncodeOptions, AnimationInput, AnimationOptions} from './types.mjs';
export type * from './types.mjs';
export type {CaptureOptions, CaptureFidelity} from './index.mjs';
export {supported, configureWasm} from './index.mjs';
export {capture, configureDecoder} from './capture-complete.mjs';
/** Compiles the still or capture kernels; this module does not provide fit or variants. */
export function prepare(operation?: 'encode' | 'capture'): Promise<void>;
/** An animation ({width, height, frames}) or a still: the full still encoder carries both, one file in place. */
export function encode(input: AnimationInput, options?: AnimationOptions): Promise<ImageResult>;
export function encode(input: ImageInput, options?: EncodeOptions): Promise<ImageResult>;

export {resultJSON} from './result.mjs';
