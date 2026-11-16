// SPDX-License-Identifier: MIT
import {queueDoor, decoderOf, isResult} from './queue-door.mjs';
import {CAPTURE_COMPLETE_SPEC} from './queue-spec-capture-complete.mjs';
import {helperReservation} from './helper-reservation.mjs';
import {webgpuUsable} from './webgpu.mjs';
import {readTexture} from './texture.mjs';
import {pixelLimit, fail} from './primitives.mjs';
import {surfaceCall, bandedCanvas, doorPreviews, admitCapturePlain} from './door-session.mjs';
const levels = {module: CAPTURE_COMPLETE_SPEC.module, ...CAPTURE_COMPLETE_SPEC.captureLevels};
const rules = {texture: readTexture, banded: bandedCanvas, richCapture: true, capPlain: admitCapturePlain, admit: (_n, opt) => {
  if (opt && typeof opt === 'object' && 'features' in opt) throw fail('JXL_OPTIONS', 'Unknown option: features; remove it.');
  const {signal: _s, onProgress: _p, onPreview: _v, firstRegion, ...rest} = opt ?? {};
  CAPTURE_COMPLETE_SPEC.captureAdmission(firstRegion === undefined ? rest : {...rest, features: {firstRegion}}, levels);
  return rest.maxPixels !== undefined ? pixelLimit(rest.maxPixels) : undefined;
}};
const door = queueDoor(CAPTURE_COMPLETE_SPEC, {result: isResult, previews: doorPreviews, helpers: helperReservation, gpu: webgpuUsable});
export const capture = surfaceCall(door, 'capture', rules), prepare = door.call('prepare'), configureDecoder = decoderOf(door);
export const {configure, close, supported} = door;
