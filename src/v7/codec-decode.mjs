// SPDX-License-Identifier: MIT
import {door} from './codec-door.mjs';
import {DECODE_SPEC} from './codec-spec-decode.mjs';
export const createCodec = door(DECODE_SPEC);
