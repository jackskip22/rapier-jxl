import type {Animation, AnimationOptions, Bytes} from './types.mjs';
export type {Animation, AnimationOptions} from './types.mjs';
export function encode(input: Animation, options?: AnimationOptions): Promise<Bytes>;
