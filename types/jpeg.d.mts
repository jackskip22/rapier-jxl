import type {JPEGOptions, JobOptions, Bytes} from './types.mjs';
export type {JPEGOptions} from './types.mjs';
export function recompress(input: Uint8Array | Blob, options?: JPEGOptions): Promise<Bytes>;
export function restore(input: Uint8Array | Blob, options?: JobOptions): Promise<Bytes>;
