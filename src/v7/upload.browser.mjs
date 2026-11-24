// SPDX-License-Identifier: MIT
import {queueDoor, decoderOf, helperLanes, isResult} from './queue-door.mjs';
import {UPLOAD_SPEC} from './queue-spec-upload.mjs';
import {helperReservation} from './helper-reservation.mjs';
import {surfaceCall, bandedCanvas, variantsResult, doorPreviews, admitUploadDoor, admitFitDoor, admitVariantsDoor, admitEncodePlain, admitCapturePlain, admitPhotoCaptureDoor, jpegSourceKeys} from './door-session.mjs';
const rules = {texture: 'jpegxl', banded: bandedCanvas, upload: true, richCapture: true, plain: admitEncodePlain, capPlain: admitCapturePlain, jpeg: jpegSourceKeys,
  admit: (name, opt, currentMax) => name === 'capture' ? admitPhotoCaptureDoor(opt, UPLOAD_SPEC)
    : name === 'encode' ? admitUploadDoor(opt).maxPixels
    : name === 'fit' ? admitFitDoor(opt, admitUploadDoor) : admitVariantsDoor(opt, currentMax, admitUploadDoor)};
const door = queueDoor(UPLOAD_SPEC, {result: variantsResult(isResult), previews: doorPreviews, helpers: helperReservation, lanes: helperLanes(UPLOAD_SPEC.defaultEffort)});
export const encode = surfaceCall(door, 'encode', rules), fit = surfaceCall(door, 'fit', rules), variants = surfaceCall(door, 'variants', rules), capture = surfaceCall(door, 'capture', rules), prepare = door.call('prepare');
export const {configure, close, supported} = door, configureDecoder = decoderOf(door);
