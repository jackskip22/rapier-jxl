// SPDX-License-Identifier: MIT
import {queueDoor, isResult} from './queue-door.mjs';
import {JPEG_SPEC} from './queue-spec-jpeg.mjs';
const door = queueDoor(JPEG_SPEC, {result: isResult});
export const recompress = door.call('recompress'), restore = door.call('restore'), prepare = door.call('prepare');
export const {configure, close, supported} = door;
