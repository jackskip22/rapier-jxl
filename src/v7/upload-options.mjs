// SPDX-License-Identifier: MIT
import {encodeOptions} from './encode-options.mjs';
import {fail, object} from './primitives.mjs';
import {featureless} from './first-region-option.mjs';

export function uploadOptions(value) {
  const options = featureless(object(value)), fields = {...options}, {effort = 3} = options;
  if ('webgpu' in options) throw fail('JXL_OPTIONS', 'unknown option: webgpu');
  if (effort === 10) throw fail('JXL_OPTIONS', "effort 10: import {encode} from 'jpegxl/max'");
  const read = encodeOptions({...fields, effort});
  if (read.effort > 3) throw fail('JXL_UNSUPPORTED', 'effort 4-9: use jpegxl');
  if (read.target !== undefined) throw fail('JXL_OPTIONS', 'measured fidelity: use jpegxl');
  if (options.features?.firstRegion !== undefined) throw fail('JXL_UNSUPPORTED', 'firstRegion: pass top-level firstRegion on encode() from jpegxl');
  if (options.features !== undefined) throw fail('JXL_OPTIONS', 'features: use format({kind: \'photo\'}) from jpegxl/format');
  return read;
}
