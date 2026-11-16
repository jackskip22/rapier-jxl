// SPDX-License-Identifier: MIT
import {queueDoor, decoderOf, helperLanes, isResult} from './queue-door.mjs';
import {STILL_SPEC} from './queue-spec-still.mjs';
import {helperReservation} from './helper-reservation.mjs';
import {webgpuUsable} from './webgpu.mjs';
import {readTexture} from './texture.mjs';
import {surfaceCall, variantsResult, doorPreviews, admitEncodeDoor, admitFitDoor, admitVariantsDoor, admitEncodePlain, jpegSourceKeys} from './door-session.mjs';
const rules = {texture: readTexture, plain: admitEncodePlain, jpeg: jpegSourceKeys, admit: (name, opt, currentMax) => name === 'encode' ? admitEncodeDoor(opt).maxPixels
  : name === 'fit' ? admitFitDoor(opt) : admitVariantsDoor(opt, currentMax)};
const door = queueDoor(STILL_SPEC, {result: variantsResult(isResult), previews: doorPreviews, helpers: helperReservation, lanes: helperLanes(), gpu: webgpuUsable});
export const encode = surfaceCall(door, 'encode', rules), fit = surfaceCall(door, 'fit', rules), variants = surfaceCall(door, 'variants', rules), prepare = door.call('prepare'), configureDecoder = decoderOf(door);
export const {configure, close, supported} = door;
