// SPDX-License-Identifier: MIT
import {queueDoor, decoderOf, helperLanes, inputExpansion, isResult} from './queue-door.mjs';
import {ANIMATION_SPEC} from './queue-spec-animation.mjs';
import {helperReservation} from './helper-reservation.mjs';
import {webgpuUsable} from './webgpu.mjs';
import {readTexture} from './texture.mjs';
import {surfaceCall, doorPreviews, checkFrames, admitEncodeDoor, admitEncodePlain, jpegSourceKeys} from './door-session.mjs';
import {isVideo, videoHead} from './video.mjs';
import {videoFrames} from './video-clip.mjs';
import {frameBridge, admitWindow} from './frame-source.mjs';
import {isFrameStream, iterableReader} from './frame-stream.mjs';
import {fail, progressOf, isBlob, dimensions} from './primitives.mjs';
import {measure} from './ownership.mjs';
import {originalByteFacts} from './result-record.mjs';
const rules = {texture: readTexture, plain: admitEncodePlain, jpeg: jpegSourceKeys, admit: (_n, opt) => admitEncodeDoor(opt).maxPixels, video: (input, options, maxPixels) => acquireVideo(input, options, maxPixels) ?? acquireStream(input, options, maxPixels)};
const door = queueDoor(ANIMATION_SPEC, {result: isResult, previews: doorPreviews, helpers: helperReservation, lanes: helperLanes(), gpu: webgpuUsable, frames: checkFrames, expand: inputExpansion});
function acquireVideo(input, options, maxPixels) {
  const element = isVideo(input), blob = isBlob(input);
  if (!element && !blob) return;
  let reading = true, video = element, shown = -1, bridge, refusing;
  const callback = options?.onProgress, cost = blob ? input.size : 0;
  const report = callback && (fraction => { if (fraction > shown) { shown = fraction; return callback(fraction); } });
  return {cost, finish: blob ? result => ({...result, ...originalByteFacts(cost, result.bytes)}) : undefined,
    settle: job => new Promise((resolve, reject) => {
      job.then(resolve, reject).finally(() => bridge?.close());
      refusing = reject;
    }),
    options: report ? {...options, onProgress: fraction => report(reading ? 0 : fraction)} : options,
    take: async (control, reserve) => {
      if (!element) video = videoHead(input.type, new Uint8Array(await input.slice(0, 12).arrayBuffer()));
      if (!video) { reading = false; return input; }
      if (options?.readAs !== undefined) throw fail('JXL_OPTIONS', 'readAs does not apply to video; remove readAs.');
      const progress = progressOf(report, control.signal, reason => control.abort(reason));
      let each = 0;
      const reserved = (bytes, width, height) => {
        if (!each) {
          admitWindow(width, height);
          each = width * height * 4 + measure({data: null, duration: 0}, Infinity);
        }
        reserve(cost + bytes + each);
      };
      const reader = await videoFrames(input, control.signal, () => {}, maxPixels, reserved);
      try { progress?.(0); await progress?.finish(); }
      catch (error) { await reader.stop(); throw error; }
      reading = false;
      bridge = frameBridge({width: reader.width, height: reader.height, next: reader.next, stop: reader.stop,
        reopen: () => videoFrames(input, control.signal, () => {}, maxPixels, reserved)});
      bridge.refused.catch(error => refusing?.(error));
      return bridge.record;
    }};
}
function acquireStream(input, options, maxPixels) {
  if (!isFrameStream(input)) return;
  let bridge, refusing;
  return {cost: 0, options,
    settle: job => new Promise((resolve, reject) => {
      job.then(resolve, reject).finally(() => bridge?.close());
      refusing = reject;
    }),
    take: async (_control, reserve) => {
      const reader = iterableReader(input);
      dimensions(reader.width, reader.height, maxPixels);
      admitWindow(reader.width, reader.height);
      reserve(2 * reader.width * reader.height * 4);
      bridge = frameBridge({width: reader.width, height: reader.height, loops: reader.loops, description: reader.description, next: reader.next, stop: reader.stop,
        reopen: async () => { await reader.reopen(); return {next: reader.next, stop: reader.stop}; }});
      bridge.refused.catch(error => refusing?.(error));
      return bridge.record;
    }};
}
export const encode = surfaceCall(door, 'encode', rules);
export const prepare = door.call('prepare'), configureDecoder = decoderOf(door);
export const {configure, close, supported} = door;
