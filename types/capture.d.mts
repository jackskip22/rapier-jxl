import type {ImageInput, CaptureOptions, Bytes} from './types.mjs';
export type {CaptureOptions, ImageInput} from './types.mjs';
export function encode(input: ImageInput, options?: CaptureOptions): Promise<Bytes>;
