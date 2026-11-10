// SPDX-License-Identifier: MIT
import {door} from './codec-door.mjs';
import {FORMAT_SPEC} from './codec-spec-format.mjs';
export const createCodec = door(FORMAT_SPEC);
