// SPDX-License-Identifier: MIT
import {queueDoor, decoderOf, helperLanes, isResult} from './queue-door.mjs';
import {FORMAT_SPEC} from './queue-spec-format.mjs';
import {helperReservation} from './helper-reservation.mjs';
import {webgpuUsable} from './webgpu.mjs';
import {readTexture} from './texture.mjs';
import {surfaceCall, doorPreviews, admitEncodeDoor, admitEncodePlain, jpegSourceKeys} from './door-session.mjs';
const rules = {texture: readTexture, plain: admitEncodePlain, jpeg: jpegSourceKeys, admit: (_n, opt) => admitEncodeDoor(opt).maxPixels};
const door = queueDoor(FORMAT_SPEC, {result: isResult, previews: doorPreviews, helpers: helperReservation, lanes: helperLanes(), gpu: webgpuUsable});
export const format = door.call('format'), encode = surfaceCall(door, 'encode', rules), prepare = door.call('prepare'), configureDecoder = decoderOf(door);
export const {configure, close, supported} = door;
