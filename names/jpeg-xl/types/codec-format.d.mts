import type {FormatCodec} from './codec.mjs';
import type {CodecConfig} from './types.mjs';
/** rapier-jxl/codec over rapier-jxl/format alone: an app that imports it carries only that module's worker and helper files. */
export function createCodec(config?: CodecConfig & {module?: 'rapier-jxl/format'}): FormatCodec;
