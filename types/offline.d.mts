import type {ImageInput, EncodeOptions, Bytes} from './types.mjs';
export function encode(input: Exclude<ImageInput, Blob>, options?: EncodeOptions & {acceleration?: 'js'}): Promise<Bytes>;
