import {fail} from './primitives.mjs';

export const isVideo = input => typeof HTMLVideoElement === 'function' && input instanceof HTMLVideoElement;
export function videoFrame(video) {
  if (video.readyState < 2) throw fail('JXL_INPUT', "Video has no frame yet; wait for loadeddata.");
  if (typeof VideoFrame !== 'function') throw fail('JXL_PLATFORM', "This host cannot read video frames; enable WebCodecs or pass RGBA pixels.");
  try { return new VideoFrame(video); }
  catch (cause) { throw Object.assign(fail('JXL_INPUT', "Video frame read failed; wait for a decoded frame or pass its RGBA pixels."), {cause}); }
}

const IMAGE_BRANDS = /^(avi[fs]|he[iv][cmsx]|m[is]f1)$/;
export function videoHead(type, head) {
  if (/^video\//i.test(type)) return true;
  if (type) return false;
  const tag = String.fromCharCode(...head.subarray(4, 12));
  return tag.startsWith('ftyp') && !IMAGE_BRANDS.test(tag.slice(4)) || head[0] === 26 && head[1] === 69 && head[2] === 223 && head[3] === 163;
}
