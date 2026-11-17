import {fail} from './primitives.mjs';

export const isVideo = input => typeof HTMLVideoElement === 'function' && input instanceof HTMLVideoElement;
export function videoFrame(video) {
  if (video.readyState < 2) throw fail('JXL_INPUT', "video frame: wait loadeddata");
  if (typeof VideoFrame !== 'function') throw fail('JXL_PLATFORM', "video frames: WebCodecs or RGBA");
  try { return new VideoFrame(video); }
  catch (cause) { throw Object.assign(fail('JXL_INPUT', "video frame: decoded or RGBA"), {cause}); }
}

const IMAGE_BRANDS = /^(avi[fs]|he[iv][cmsx]|m[is]f1)$/;
export function videoHead(type, head) {
  if (/^video\//i.test(type)) return true;
  if (type && !/^application\/octet-stream(?:;|$)/i.test(type)) return false;
  const tag = String.fromCharCode(...head.subarray(4, 12));
  return tag.startsWith('ftyp') && !IMAGE_BRANDS.test(tag.slice(4)) || head[0] === 26 && head[1] === 69 && head[2] === 223 && head[3] === 163;
}

