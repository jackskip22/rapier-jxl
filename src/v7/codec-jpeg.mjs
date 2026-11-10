// SPDX-License-Identifier: MIT
import {door} from './codec-door.mjs';
import {JPEG_SPEC} from './codec-spec-jpeg.mjs';
export const createCodec = door(JPEG_SPEC);
