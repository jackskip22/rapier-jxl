// SPDX-License-Identifier: MIT
import {inspectPhone} from './phone-container.mjs';
import {preparationWith} from './preparation-with.mjs';
import {uploadOptions} from './upload-options.mjs';

export function preparationUpload(encode, hooks) {
  return preparationWith(encode, {phone: inspectPhone, ...hooks, admitEncode: uploadOptions, carriesJpeg: true, retainedFit: undefined, readTexture: undefined});
}
