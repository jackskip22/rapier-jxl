import type {ImageInput, EncodeOptions, AnimationInput, AnimationOptions, Bytes} from './types.mjs';
export type * from './types.mjs';
export type {CaptureOptions, CaptureFidelity} from './index.mjs';
export {capture, supported, configureWasm} from './index.mjs';
/** Compiles the still or capture kernels; this module does not provide fit or variants. */
export function prepare(operation?: 'encode' | 'capture'): Promise<void>;
/** An animation ({width, height, frames}) or a still: the full still encoder carries both, one file in place. */
export function encode(input: AnimationInput, options?: AnimationOptions): Promise<Bytes>;
export function encode(input: ImageInput, options?: EncodeOptions): Promise<Bytes>;
