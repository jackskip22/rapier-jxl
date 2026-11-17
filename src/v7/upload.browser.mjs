// SPDX-License-Identifier: MIT
import {queueDoor, decoderOf, helperLanes, isResult} from './queue-door.mjs';
import {UPLOAD_SPEC} from './queue-spec-upload.mjs';
import {helperReservation} from './helper-reservation.mjs';
import {pixelLimit, fail} from './primitives.mjs';
import {surfaceCall, bandedCanvas, variantsResult, doorPreviews, admitUploadDoor, admitFitDoor, admitVariantsDoor, admitEncodePlain, admitCapturePlain, jpegSourceKeys} from './door-session.mjs';
const levels = {module: UPLOAD_SPEC.module, ...UPLOAD_SPEC.captureLevels};
const rules = {texture: 'jpegxl', banded: bandedCanvas, upload: true, richCapture: true, plain: admitEncodePlain, capPlain: admitCapturePlain, jpeg: jpegSourceKeys,
  admit: (name, opt, currentMax) => {
    if (name === 'capture') {
      if (opt && typeof opt === 'object' && 'features' in opt) throw fail('JXL_OPTIONS', 'unknown option: features');
      const {signal: _s, onProgress: _p, onPreview: _v, firstRegion, ...rest} = opt ?? {};
      UPLOAD_SPEC.captureAdmission(firstRegion === undefined ? rest : {...rest, features: {firstRegion}}, levels);
      return rest.maxPixels !== undefined ? pixelLimit(rest.maxPixels) : undefined;
    }
    if (name === 'encode') return admitUploadDoor(opt).maxPixels;
    return name === 'fit' ? admitFitDoor(opt, admitUploadDoor) : admitVariantsDoor(opt, currentMax, admitUploadDoor);
  }};
const door = queueDoor(UPLOAD_SPEC, {result: variantsResult(isResult), previews: doorPreviews, helpers: helperReservation, lanes: helperLanes(UPLOAD_SPEC.defaultEffort)});
export const encode = surfaceCall(door, 'encode', rules), fit = surfaceCall(door, 'fit', rules), variants = surfaceCall(door, 'variants', rules), capture = surfaceCall(door, 'capture', rules), prepare = door.call('prepare');
export const {configure, close, supported} = door, configureDecoder = decoderOf(door);
