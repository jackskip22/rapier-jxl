// SPDX-License-Identifier: MIT
import {queueDoor, decoderOf, helperLanes, inputExpansion, isResult} from './queue-door.mjs';
import {ANIMATION_SPEC} from './queue-spec-animation.mjs';
import {helperReservation} from './helper-reservation.mjs';
import {webgpuUsable} from './webgpu.mjs';
import {readTexture} from './texture.mjs';
import {surfaceCall, doorPreviews, checkFrames, admitEncodeDoor, admitEncodePlain, jpegSourceKeys} from './door-session.mjs';
import {isVideo, videoHead} from './video.mjs';
import {readVideo} from './video-clip.mjs';
import {fail, progressOf} from './primitives.mjs';
import {measure} from './ownership.mjs';
import {originalByteFacts} from './result-record.mjs';
const rules = {texture: readTexture, plain: admitEncodePlain, jpeg: jpegSourceKeys, admit: (_n, opt) => admitEncodeDoor(opt).maxPixels, video: acquireVideo};
const door = queueDoor(ANIMATION_SPEC, {result: isResult, previews: doorPreviews, helpers: helperReservation, lanes: helperLanes(), gpu: webgpuUsable, frames: checkFrames, expand: inputExpansion});
function acquireVideo(input, options, maxPixels) {
  const element = isVideo(input), blob = typeof Blob === 'function' && input instanceof Blob;
  if (!element && !blob) return;
  let reading = true, video = element, shown = -1;
  const callback = options?.onProgress, cost = blob ? input.size : 0;
  const report = callback && (fraction => { if (fraction > shown) { shown = fraction; return callback(fraction); } });
  return {cost, finish: blob ? result => ({...result, ...originalByteFacts(cost, result.bytes)}) : undefined,
    options: report ? {...options, onProgress: fraction => report(reading ? 0 : video ? 0.5 + fraction / 2 : fraction)} : options,
    take: async (control, reserve) => {
      if (!element) video = videoHead(input.type, new Uint8Array(await input.slice(0, 12).arrayBuffer()));
      if (!video) { reading = false; return input; }
      if (options?.readAs !== undefined) throw fail('JXL_OPTIONS', 'readAs does not apply to video; remove readAs.');
      const progress = progressOf(report, control.signal, reason => control.abort(reason));
      const clip = await readVideo(input, control.signal, fraction => progress?.(fraction / 2), maxPixels, bytes => reserve(cost + bytes));
      reserve(measure(clip, maxPixels));
      progress?.(0.5); await progress?.finish(); reading = false;
      return clip;
    }};
}
export const encode = surfaceCall(door, 'encode', rules);
export const prepare = door.call('prepare'), configureDecoder = decoderOf(door);
export const {configure, close, supported} = door;

