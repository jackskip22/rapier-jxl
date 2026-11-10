// SPDX-License-Identifier: MIT
import {STILL_SPEC} from './codec-spec-still.mjs';
import {UPLOAD_SPEC} from './codec-spec-upload.mjs';
import {ANIMATION_SPEC} from './codec-spec-animation.mjs';
import {FORMAT_SPEC} from './codec-spec-format.mjs';
import {CAPTURE_SPEC} from './codec-spec-capture.mjs';
import {CAPTURE_COMPLETE_SPEC} from './codec-spec-capture-complete.mjs';
import {DECODE_SPEC} from './codec-spec-decode.mjs';
import {JPEG_SPEC} from './codec-spec-jpeg.mjs';
export const MODULES = Object.freeze({
  'rapier-jxl': STILL_SPEC,
  'rapier-jxl/upload': UPLOAD_SPEC,
  'rapier-jxl/animation': ANIMATION_SPEC,
  'rapier-jxl/format': FORMAT_SPEC,
  'rapier-jxl/capture': CAPTURE_SPEC,
  'rapier-jxl/capture-complete': CAPTURE_COMPLETE_SPEC,
  'rapier-jxl/decode': DECODE_SPEC,
  'rapier-jxl/jpeg': JPEG_SPEC,
});
