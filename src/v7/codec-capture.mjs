// SPDX-License-Identifier: MIT
import {door} from './codec-door.mjs';
import {CAPTURE_SPEC} from './codec-spec-capture.mjs';
export const createCodec = door(CAPTURE_SPEC);
