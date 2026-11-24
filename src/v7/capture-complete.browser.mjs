// SPDX-License-Identifier: MIT
import {queueDoor, decoderOf, isResult} from './queue-door.mjs';
import {CAPTURE_COMPLETE_SPEC} from './queue-spec-capture-complete.mjs';
import {helperReservation} from './helper-reservation.mjs';
import {webgpuUsable} from './webgpu.mjs';
import {readTexture} from './texture.mjs';
import {surfaceCall, bandedCanvas, doorPreviews, admitCapturePlain, admitPhotoCaptureDoor} from './door-session.mjs';
const rules = {texture: readTexture, banded: bandedCanvas, richCapture: true, capPlain: admitCapturePlain,
  admit: (_n, opt) => admitPhotoCaptureDoor(opt, CAPTURE_COMPLETE_SPEC)};
const door = queueDoor(CAPTURE_COMPLETE_SPEC, {result: isResult, previews: doorPreviews, helpers: helperReservation, gpu: webgpuUsable});
export const capture = surfaceCall(door, 'capture', rules), prepare = door.call('prepare'), configureDecoder = decoderOf(door);
export const {configure, close, supported} = door;
