// SPDX-License-Identifier: MIT
import {queueDoor, isResult} from './queue-door.mjs';
import {CAPTURE_SPEC} from './queue-spec-capture.mjs';
import {surfaceCall, bandedCanvas, doorPreviews, admitCaptureDoor, admitCapturePlain} from './door-session.mjs';
const levels = {module: CAPTURE_SPEC.module, ...CAPTURE_SPEC.captureLevels};
const rules = {texture: 'jpegxl/capture-complete or jpegxl', banded: bandedCanvas, capPlain: admitCapturePlain, admit: (_n, opt) => admitCaptureDoor(opt, levels)};
const door = queueDoor(CAPTURE_SPEC, {result: isResult, previews: doorPreviews});
export const capture = surfaceCall(door, 'capture', rules), prepare = door.call('prepare');
export const {configure, close, supported} = door;
