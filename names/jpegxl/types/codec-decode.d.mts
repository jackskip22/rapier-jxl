import type {DecodeCodec} from './codec.mjs';
import type {CodecConfig} from './types.mjs';
/** rapier-jxl/codec over rapier-jxl/decode alone: an app that imports it carries only that module's worker and helper files. */
export function createCodec(config?: Omit<CodecConfig, 'webgpu' | 'helpers'> & {webgpu?: never; helpers?: never; module?: 'rapier-jxl/decode'}): DecodeCodec;
