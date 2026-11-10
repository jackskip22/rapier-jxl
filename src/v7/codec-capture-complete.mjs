// SPDX-License-Identifier: MIT
import {door} from './codec-door.mjs';
import {CAPTURE_COMPLETE_SPEC} from './codec-spec-capture-complete.mjs';
export const createCodec = door(CAPTURE_COMPLETE_SPEC);
