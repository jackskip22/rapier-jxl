// SPDX-License-Identifier: MIT
import {queueDoor, decoderOf, helperLanes, isResult} from './queue-door.mjs';
import {helperReservation} from './helper-reservation.mjs';
import {webgpuUsable} from './webgpu.mjs';
import {readTexture} from './texture.mjs';
import {surfaceCall, variantsResult, doorPreviews, admitEncodeDoor, admitFitDoor, admitVariantsDoor, admitEncodePlain, jpegSourceKeys} from './door-session.mjs';

export function fullBrowser(spec, ten = false) {
  const rules = {texture: readTexture, plain: admitEncodePlain, jpeg: jpegSourceKeys, admit: (name, opt, currentMax) => name === 'encode' ? admitEncodeDoor(opt, ten).maxPixels
    : name === 'fit' ? admitFitDoor(opt) : admitVariantsDoor(opt, currentMax)};
  const door = queueDoor(spec, {result: variantsResult(isResult), previews: doorPreviews, helpers: helperReservation, lanes: helperLanes(ten ? 10 : 7), gpu: webgpuUsable});
  return {encode: surfaceCall(door, 'encode', rules), fit: surfaceCall(door, 'fit', rules), variants: surfaceCall(door, 'variants', rules),
    prepare: door.call('prepare'), configureDecoder: decoderOf(door), configure: door.configure, close: door.close, supported: door.supported};
}
