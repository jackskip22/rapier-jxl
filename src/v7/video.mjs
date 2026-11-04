import {fail} from './primitives.mjs';

export const isVideo = input => typeof HTMLVideoElement === 'function' && input instanceof HTMLVideoElement;
export function videoFrame(video) {
  if (video.readyState < 2) throw fail('JXL_INPUT', 'The video has no frame yet; wait for loadeddata.');
  if (typeof VideoFrame !== 'function') throw fail('JXL_PLATFORM', 'Reading a video needs WebCodecs (VideoFrame).');
  try { return new VideoFrame(video); }
  catch (cause) { throw Object.assign(fail('JXL_INPUT', 'The video could not be read: ' + (cause?.message || cause)), {cause}); }
}
