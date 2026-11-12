import type {CaptureCompleteCodec} from './codec.mjs';
import type {CodecConfig} from './types.mjs';
/** rapier-jxl/codec over rapier-jxl/capture-complete alone: an app that imports it carries only that module's worker and helper files. */
export function createCodec(config?: CodecConfig & {module?: 'rapier-jxl/capture-complete'}): CaptureCompleteCodec;
