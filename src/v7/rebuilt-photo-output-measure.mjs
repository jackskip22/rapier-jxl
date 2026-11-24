// SPDX-License-Identifier: MIT
import {capturePictureMeasure, prepareCapturePictureMeasure} from '../capture-picture-measure.mjs';
import {photoOutputOperation} from './photo-output-operation.mjs';
import {rebuildShown, rebuildPicture} from '../photo-rebuild.mjs';
import {codedBytesFromLinear} from '../color-bytes.mjs';
import {P3_TRANSFORM} from '../color-transform.mjs';
import {fail} from './primitives.mjs';

function shownPicture(image, {width, height, colorSpace}) {
  if (!image) throw fail('JXL_INTERNAL', 'rebuilt-photo-output:image');
  const read = {width, height, colorSpace, sampleFormat: 'uint', bitDepth: 8, alphaPremultiplied: false};
  if (colorSpace === 'srgb') {
    const shown = rebuildShown(image);
    return {...read, data: shown.rgba, native: shown.native()};
  }
  const made = rebuildPicture(image, {rgba: true, linear: true}), n = width * height;
  const data = codedBytesFromLinear(made.linear, n, P3_TRANSFORM);
  for (let at = 3; at < data.length; at += 4) data[at] = made.rgba[at];
  return {...read, data};
}

export function rebuiltPhotoOutputMeasure(source, options) {
  return photoOutputOperation(source, options, {
    prepare: prepareCapturePictureMeasure,
    metric: capturePictureMeasure,
    read: (_bytes, {width, height, colorSpace}, image) => shownPicture(image, {width, height, colorSpace}),
  });
}
