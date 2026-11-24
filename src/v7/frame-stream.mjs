// SPDX-License-Identifier: MIT
import {fail, check, callers, plainCopy, dimensions, PIXELS} from './primitives.mjs';
import {arrayBufferBytes, liveView} from './bytes.mjs';
import {isPlainRecord} from './records.mjs';
import {record as ownRecord} from './ownership.mjs';
import {described} from './describe.mjs';
import {readGifStream, gifFrameCount} from './gif-source.mjs';
import {admitWindow} from './frame-source.mjs';

export const STREAM_BYTES = 2 ** 26;

const eightBit = description => description.orientation === undefined && description.extraChannels === undefined && (description.bitDepth === undefined || description.bitDepth === 8) && (description.sampleFormat === undefined || description.sampleFormat === 'uint');

export function isFrameStream(input) {
  if (!isPlainRecord(input)) return false;
  const field = Object.getOwnPropertyDescriptor(input, 'frames');
  if (!field) return false;
  if (!('value' in field)) throw fail('JXL_INPUT', 'queue records: plain values');
  const frames = field.value;
  return frames !== null && typeof frames === 'object' && !Array.isArray(frames) &&
    (typeof frames[Symbol.asyncIterator] === 'function' || typeof frames[Symbol.iterator] === 'function');
}

const iterate = frames => {
  try { return typeof frames[Symbol.asyncIterator] === 'function' ? frames[Symbol.asyncIterator]() : frames[Symbol.iterator](); }
  catch (error) { throw callers(error); }
};
const FRAME_KEYS = new Set(['data', 'duration', 'width', 'height']);

export function iterableReader(input, maxPixels = PIXELS) {
  const {width, height, frames} = input, loops = input.loops ?? 0;
  dimensions(width, height, maxPixels);
  if (!Number.isSafeInteger(loops) || loops < 0 || loops > 0xffffffff) throw fail('JXL_INPUT', 'loops: integer 0-4294967295');
  const description = described(input);
  if (!eightBit(description)) throw fail('JXL_INPUT', 'frames iterable: 8-bit RGBA samples');
  const size = width * height * 4;
  let current = iterate(frames), count = 0;
  const reader = {width, height, loops, description,
    next: async () => {
      let step;
      try { step = await current.next(); } catch (error) { throw callers(error); }
      if (!step || typeof step !== 'object') throw fail('JXL_INPUT', 'frames iterator: {done, value} step');
      if (step.done) return null;
      const frame = step.value;
      if (!isPlainRecord(frame)) throw fail('JXL_INPUT', `frames[${count}]: {data, duration} plain record`);
      for (const [key] of ownRecord(frame)) if (!FRAME_KEYS.has(key))
        throw fail('JXL_INPUT', `frames[${count}].${key}: {data, duration}`);
      if ((frame.width !== undefined && frame.width !== width) || (frame.height !== undefined && frame.height !== height))
        throw fail('JXL_INPUT', `frames[${count}]: ${width} x ${height} frame dimensions required`);
      const data = frame.data;
      if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray))
        throw fail('JXL_INPUT', `frames[${count}]: ${width} x ${height} RGBA, 8 bits a sample`);
      const fields = liveView(data);
      if (!fields) throw fail('JXL_INPUT', 'ArrayBuffer: live and sized');
      if (arrayBufferBytes(fields[0]) === null) throw fail('JXL_INPUT', 'shared buffer: copy to ArrayBuffer');
      if (fields[2] !== size)
        throw fail('JXL_INPUT', `frames[${count}]: ${width} x ${height} RGBA, 8 bits a sample`);
      if (typeof frame.duration !== 'number' || !Number.isFinite(frame.duration) || frame.duration < 0 || frame.duration > 0xffffffff)
        throw fail('JXL_INPUT', 'frame duration: finite ms >=0');
      count++;
      return {data: plainCopy(data), duration: frame.duration};
    },
    stop: async () => { try { await current.return?.(); } catch {} },
    reopen: async () => {
      await reader.stop();
      const again = iterate(frames);
      if (again === current) throw fail('JXL_INPUT', 'frames: a lossy clip needs a second read; give frames that iterate again, or quality 100');
      current = again; count = 0;
    }};
  return reader;
}

export async function gifReader(bytes, maxPixels) {
  const frames = gifFrameCount(bytes);
  if (frames > 1 && bytes.length >= 13) {
    const w = bytes[6] | (bytes[7] << 8), h = bytes[8] | (bytes[9] << 8);
    if (w > 0 && h > 0 && w * h <= (maxPixels ?? PIXELS) && w * h * 4 * frames > STREAM_BYTES) admitWindow(w, h);
  }
  const open = () => readGifStream(bytes, 'input.gif', maxPixels);
  const probe = frames > 1 ? open() : null;
  if (!probe) return null;
  if (probe.width * probe.height * 4 * frames <= STREAM_BYTES) { probe.stop(); return null; }
  let current = probe;
  return {width: probe.width, height: probe.height, loops: probe.loops, next: async () => current.next(), stop: async () => current.stop(),
    reopen: async () => { current.stop(); current = open(); }};
}

const PNG = [0x89, 0x50, 0x4e, 0x47], RIFF = [0x52, 0x49, 0x46, 0x46];
export async function decoderReader(blob, head, maxPixels, signal) {
  const type = PNG.every((b, i) => head[i] === b) ? 'image/png' : RIFF.every((b, i) => head[i] === b) && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50 ? 'image/webp' : null;
  if (!type || typeof globalThis.ImageDecoder !== 'function') return null;
  const open = async () => {
    let made;
    try {
      made = new ImageDecoder({data: blob.stream(), type});
      await made.tracks.ready;
      return made;
    } catch (cause) {
      try { made?.close(); } catch {}
      check(signal);
      throw Object.assign(fail('JXL_INPUT', 'animated image decode: pass a complete image file'), {cause});
    }
  };
  let decoder = await open();
  try {
    const track = decoder.tracks.selectedTrack;
    if (!track?.animated || !(track.frameCount > 1)) { decoder.close(); return null; }
    const loops = track.repetitionCount === Infinity ? 0 : Math.max(0, track.repetitionCount);
    let index = 0, canvas = null, context = null, width = 0, height = 0;
    let first;
    try { first = await decoder.decode({frameIndex: 0}); }
    catch (cause) { check(signal); throw Object.assign(fail('JXL_INPUT', 'animated image decode: pass a complete image file'), {cause}); }
    width = first.image.displayWidth; height = first.image.displayHeight;
    first.image.close();
    dimensions(width, height, maxPixels);
    admitWindow(width, height);
    canvas = new OffscreenCanvas(width, height);
    context = canvas.getContext('2d', {willReadFrequently: true});
    const reader = {width, height, loops,
      next: async () => {
        check(signal);
        if (index >= track.frameCount) return null;
        let decoded;
        try { decoded = await decoder.decode({frameIndex: index++}); }
        catch (cause) { check(signal); throw Object.assign(fail('JXL_INPUT', 'animated image decode: pass a complete image file'), {cause}); }
        const {image} = decoded;
        try {
          context.clearRect(0, 0, width, height);
          context.drawImage(image, 0, 0);
          const data = new Uint8ClampedArray(context.getImageData(0, 0, width, height).data.buffer);
          return {data, duration: Math.max(0, Math.round((image.duration ?? 0) / 1000))};
        } finally { image.close(); }
      },
      stop: async () => { try { decoder.close(); } catch {} },
      reopen: async () => { try { decoder.close(); } catch {} decoder = await open(); index = 0; }};
    return reader;
  } catch (error) {
    try { decoder.close(); } catch {}
    throw error;
  }
}

export function arrayWindowable(animation, width, height) {
  const frames = animation.frames;
  if (!eightBit(described(animation))) return false;
  return frames.every(frame => (frame.data instanceof Uint8Array || frame.data instanceof Uint8ClampedArray) && frame.data.byteLength === width * height * 4);
}
export function arrayReader({width, height, loops = 0, frames}) {
  let at = 0;
  return {width, height, loops, next: async () => at < frames.length ? {data: frames[at].data, duration: frames[at++].duration} : null,
    stop: async () => {}, reopen: async () => { at = 0; }};
}
