// SPDX-License-Identifier: MIT
import {door} from './codec-door.mjs';
import {UPLOAD_SPEC} from './codec-spec-upload.mjs';
export const createCodec = door(UPLOAD_SPEC);
