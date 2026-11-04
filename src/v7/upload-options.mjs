// SPDX-License-Identifier: MIT
import {encodeOptions} from './encode-options.mjs';
import {fail, object} from './primitives.mjs';
import {featureless} from './first-region-option.mjs';

export function uploadOptions(value) {
  const options = featureless(object(value)), fields = {...options}, {effort = 3} = options;
  const read = encodeOptions({...fields, effort});
  if (read.effort > 3) throw fail('JXL_UNSUPPORTED', 'The upload encoder runs efforts 1-3; rapier-jxl runs 4-9.');
  if (read.target !== undefined) throw fail('JXL_OPTIONS', 'A measured fidelity is rapier-jxl\'s.');
  if (options.features?.firstRegion !== undefined) throw fail('JXL_UNSUPPORTED', 'firstRegion is rapier-jxl\'s.');
  if (options.features !== undefined) throw fail('JXL_OPTIONS', 'Codestream features are rapier-jxl\'s.');
  return read;
}
