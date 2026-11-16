// SPDX-License-Identifier: MIT
import {capturePictureMeasure, prepareCapturePictureMeasure} from '../capture-picture-measure.mjs';
import {captureReader, DECODER_SNAPSHOT} from '../shown-picture.mjs';
import {photoOutputOperation} from './photo-output-operation.mjs';
import {photoKernels} from '../capture-kernels.mjs';

export function nativePhotoOutputMeasure(source, options) {
  const read = captureReader(options && DECODER_SNAPSHOT in options ? options[DECODER_SNAPSHOT] : undefined);
  const {width, height} = source;
  let alpha, data = source.data;
  return photoOutputOperation(source, options, {
    prepare: prepareCapturePictureMeasure,
    metric: capturePictureMeasure,
    read: (bytes, {format: _format, ...rest}) => {
      if (alpha === undefined && data) try { alpha = !photoKernels().opaque(data, width, 0, 0, width, height); } catch { alpha = true; } finally { data = null; }
      return read(bytes, alpha === false ? {...rest, alpha} : rest);
    },
  });
}
