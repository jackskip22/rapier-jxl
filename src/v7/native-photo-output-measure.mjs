// SPDX-License-Identifier: MIT
import {capturePictureMeasure, prepareCapturePictureMeasure} from '../capture-picture-measure.mjs';
import {captureReader} from '../shown-picture.mjs';
import {photoOutputOperation} from './photo-output-operation.mjs';

export function nativePhotoOutputMeasure(source, options) {
  const read = captureReader();
  return photoOutputOperation(source, options, {
    prepare: prepareCapturePictureMeasure,
    metric: capturePictureMeasure,
    read: (bytes, {format: _format, ...rest}) => read(bytes, rest),
  });
}
