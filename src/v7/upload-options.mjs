// SPDX-License-Identifier: MIT
import {encodeOptions} from './encode-options.mjs';
import {fail, object} from './primitives.mjs';
import {featureless} from './first-region-option.mjs';

export function uploadOptions(value) {
  const options = featureless(object(value)), fields = {...options}, {effort = 3} = options;
  if ('webgpu' in options) throw fail('JXL_OPTIONS', 'Unknown option: webgpu; remove it (upload runs on WebAssembly).');
  const read = encodeOptions({...fields, effort});
  if (read.effort > 3) throw fail('JXL_UNSUPPORTED', "Upload encoder does not run this effort; use rapier-jxl for efforts 4–9.");
  if (read.target !== undefined) throw fail('JXL_OPTIONS', "Upload encoder cannot measure fidelity; use rapier-jxl.");
  if (options.features?.firstRegion !== undefined) throw fail('JXL_UNSUPPORTED', "Upload encoder does not support firstRegion; use rapier-jxl.");
  if (options.features !== undefined) throw fail('JXL_OPTIONS', "Upload encoder does not support codestream features; use rapier-jxl.");
  return read;
}
