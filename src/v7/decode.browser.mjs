// SPDX-License-Identifier: MIT
import {queueDoor} from './queue-door.mjs';
import {DECODE_SPEC} from './queue-spec-decode.mjs';
const door = queueDoor(DECODE_SPEC);
export const decode = door.call('decode'), prepare = door.call('prepare');
export const {configure, close, supported} = door;
