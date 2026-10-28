import type {Pixels, EncodeOptions, Bytes} from './types.mjs';
export function encode(input: Pixels, options?: EncodeOptions & {acceleration?: 'js'}): Promise<Bytes>;
