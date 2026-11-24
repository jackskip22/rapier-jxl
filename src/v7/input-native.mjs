// SPDX-License-Identifier: MIT
import {check, dimensions, fail, blobBytes, unreadInput, isBlob, filePassed, abortable} from './primitives.mjs';
import {surface} from './surface.mjs';
import {jpegYCbCr} from '../jpeg-color.mjs';

export async function image(input, options, hooks = {}, readBlob = nativeBlob) {
  check(hooks.signal);
  if (isBlob(input)) {
    const head = await blobBytes(input, hooks.signal, 0, 32);
    check(hooks.signal);
    const png = pngHeader(head, hooks.maxPixels);
    if (png) {
      const chunks = await pngChunks(input, hooks.signal) ?? await pngChunks(input, hooks.signal, Infinity);
      if (chunks.names.has('acTL') || chunks.names.has('fcTL')) throw animated('PNG');
    } else if (head.length >= 12 && String.fromCharCode(...head.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...head.subarray(8, 12)) === 'WEBP')
      riffDimensions(head, hooks.maxPixels);
    else if (head[0] === 255 && head[1] === 216) await jpegBlobDimensions(input, hooks.maxPixels, hooks.signal);
    else if (head[0] === 71 && head[1] === 73 && head[2] === 70) await gifBlobDimensions(input, head, hooks.maxPixels, hooks.signal);
    else if (head[0] === 66 && head[1] === 77) bmpDimensions(head, hooks.maxPixels);
    return readBlob(input, options, hooks, head, png);
  }
  return pixels(input, options, hooks.maxPixels);
}

export function pngHeader(head, maxPixels) {
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => head[i] === byte)) return false;
  if (head.length < 29 || head[12] !== 73 || head[13] !== 72 || head[14] !== 68 || head[15] !== 82)
    throw fail('JXL_INPUT', "PNG header: incomplete");
  const view = new DataView(head.buffer);
  dimensions(view.getUint32(16), view.getUint32(20), maxPixels);
  return true;
}

const animated = kind => fail('JXL_UNSUPPORTED', `animated ${kind}: use jpegxl/animation`);
function riffDimensions(head, maxPixels) {
  if (head.length < 20) throw fail('JXL_INPUT', 'RIFF header: incomplete; pass a complete image file');
  const kind = String.fromCharCode(...head.subarray(12, 16)), u24 = i => head[i] | head[i + 1] << 8 | head[i + 2] << 16;
  const chunkSize = (head[16] | head[17] << 8 | head[18] << 16 | head[19] << 24) >>> 0;
  if (kind === 'VP8X') {
    if (head.length >= 21 && head[20] & 2) throw animated('WebP');
    if (head.length < 30 || chunkSize !== 10) throw fail('JXL_INPUT', 'VP8X header: invalid; pass a complete image file');
    dimensions(1 + u24(24), 1 + u24(27), maxPixels);
  } else if (kind === 'VP8L') {
    if (head.length < 25 || chunkSize < 5 || head[20] !== 0x2f) throw fail('JXL_INPUT', 'VP8L header: invalid; pass a complete image file');
    const bits = head[21] | head[22] << 8 | head[23] << 16 | head[24] << 24;
    dimensions(1 + (bits & 0x3fff), 1 + (bits >>> 14 & 0x3fff), maxPixels);
  } else if (kind === 'VP8 ') {
    if (head.length < 30 || chunkSize < 10 || (head[20] & 1) || head[23] !== 0x9d || head[24] !== 0x01 || head[25] !== 0x2a)
      throw fail('JXL_INPUT', 'VP8 frame header: invalid; pass a complete image file');
    const width = head[26] | (head[27] & 0x3f) << 8, height = head[28] | (head[29] & 0x3f) << 8;
    if (!width || !height) throw fail('JXL_INPUT', 'VP8 dimensions: invalid; pass a non-empty image');
    dimensions(width, height, maxPixels);
  } else throw fail('JXL_INPUT', 'RIFF image chunk: invalid; pass a valid image file');
}

export async function pngChunks(blob, signal, limit = 64) {
  const names = new Set();
  let intent, cicp;
  for (let offset = 8, n = 0; n < limit; n++) {
    if (offset + 8 > blob.size) return {names, intent, cicp};
    const head = new DataView((await blobBytes(blob, signal, offset, offset + 12)).buffer);
    check(signal);
    if (head.byteLength < 8) return {names, intent, cicp};
    const len = head.getUint32(0);
    const name = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
    if (name === 'IDAT' || name === 'IEND') return {names, intent, cicp};
    if (len > 0x7fffffff || offset + 12 + len > blob.size) return {names, intent, cicp};
    names.add(name);
    if (name === 'sRGB') intent = len === 1 && head.byteLength >= 9 ? head.getUint8(8) : undefined;
    if (name === 'cICP') cicp = len === 4 && head.byteLength >= 12 ? [8, 9, 10, 11].map(i => head.getUint8(i)) : undefined;
    offset += 12 + len;
  }
  return null;
}

const UNREAD = {unread: true}, ICC_BYTES = 4 * 1024 * 1024;
export const blobProfile = ((typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) || (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true)) ? null : async function blobProfile(blob, head, signal) {
  const u32le = (b, i) => (b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24) >>> 0;
  const tag = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
  if (head.length >= 30 && tag(head, 0) === 'RIFF' && tag(head, 8) === 'WEBP') {
    if (tag(head, 12) !== 'VP8X' || !(head[20] & 0x20)) return null;
    if (u32le(head, 16) !== 10 || u32le(head, 4) + 8 > blob.size) return UNREAD;
    const at = 30, chunk = await blobBytes(blob, signal, at, at + 8);
    if (chunk.length < 8 || tag(chunk, 0) !== 'ICCP') return UNREAD;
    const size = u32le(chunk, 4), end = at + 8 + size + (size & 1);
    if (!size || end > u32le(head, 4) + 8 || size > ICC_BYTES) return UNREAD;
    const icc = await blobBytes(blob, signal, at + 8, at + 8 + size);
    const top = await blobBytes(blob, signal, 0, 30);
    new DataView(top.buffer, top.byteOffset).setUint32(4, u32le(top, 4) - (end - at), true);
    top[20] &= ~0x20;
    return {icc, plain: new Blob([top, blob.slice(30, at), blob.slice(end)], {type: blob.type})};
  }
  if (head[0] !== 255 || head[1] !== 216) return null;
  const parts = [], cuts = [];
  for (let at = 2, n = 0; at + 4 <= blob.size; n++) {
    if (n === 4096) return UNREAD;
    const marker = await blobBytes(blob, signal, at, at + 18);
    if (marker.length < 4 || marker[0] !== 255) return UNREAD;
    if (marker[1] === 255) { at++; continue; }
    if (marker[1] === 0xDA || marker[1] === 0xD9) break;
    if (marker[1] === 1 || marker[1] >= 0xD0 && marker[1] <= 0xD7) { at += 2; continue; }
    const size = marker[2] << 8 | marker[3];
    if (size < 2 || at + 2 + size > blob.size) return UNREAD;
    if (marker[1] === 0xE2 && size >= 17 && marker.length === 18 && String.fromCharCode(...marker.subarray(4, 16)) === 'ICC_PROFILE\0') {
      parts.push({seq: marker[16], count: marker[17], start: at + 18, end: at + 2 + size});
      cuts.push([at, at + 2 + size]);
    }
    at += 2 + size;
  }
  if (!parts.length) return null;
  parts.sort((a, b) => a.seq - b.seq);
  if (parts.some((part, i) => part.seq !== i + 1 || part.count !== parts.length) ||
      parts.reduce((sum, part) => sum + part.end - part.start, 0) > ICC_BYTES) return UNREAD;
  const read = await blobBytes(new Blob(parts.map(part => blob.slice(part.start, part.end))), signal);
  const declared = read.length >= 4 ? new DataView(read.buffer, read.byteOffset).getUint32(0) : 0;
  const icc = declared >= 132 && declared < read.length ? read.subarray(0, declared) : read;
  const kept = [];
  let from = 0;
  for (const [start, end] of cuts) { kept.push(blob.slice(from, start)); from = end; }
  kept.push(blob.slice(from));
  return {icc, plain: new Blob(kept, {type: blob.type})};
};

export function requirePNGReader(options, hooks) {
  if (options?.readAs !== undefined) throw fail('JXL_OPTIONS', "readAs: not with PNG16");
  if (!hooks?.deep) throw fail('JXL_INPUT', '16-bit PNG: use jpegxl');
}
function nativeBlob(input, options, hooks, head, png) {
  if (png && head[24] === 16) requirePNGReader(options);
  return nativeBitmap(input, options, hooks);
}

export async function nativeBitmap(input, options, hooks, policy) {
  const prepared = await policy?.prepare?.();
  check(hooks.signal);
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function')
    throw fail('JXL_PLATFORM', 'image decoder: unavailable; ' + (policy?.platform?.() ?? 'use 8-bit RGBA pixels'));
  let bitmap;
  try {
    const source = policy?.blob?.(prepared) ?? input, region = policy?.region;
    bitmap = await abortable(region ? createImageBitmap(source, region.x, region.y, region.width, region.height, {imageOrientation: 'from-image'})
      : createImageBitmap(source, {imageOrientation: 'from-image'}), hooks.signal, value => value.close());
  }
  catch (cause) { check(hooks.signal); throw Object.assign(fail('JXL_INPUT', policy?.failure?.(prepared) ?? 'image decode: complete file or RGBA pixels'), {cause}); }
  try {
    check(hooks.signal); dimensions(bitmap.width, bitmap.height, hooks.maxPixels);
    policy?.admit?.(bitmap, prepared);
    const picture = surface(bitmap, {maxPixels: hooks.maxPixels, readAs: options?.readAs});
    return picture;
  } finally { bitmap.close(); }
}

async function gifBlobDimensions(input, head, maxPixels, signal) {
  if (head.length < 13 || head[3] !== 56 || (head[4] !== 55 && head[4] !== 57) || head[5] !== 97)
    throw fail('JXL_INPUT', 'GIF header: invalid; pass a GIF87a or GIF89a file');
  let width = head[6] | head[7] << 8, height = head[8] | head[9] << 8;
  if (width && height) dimensions(width, height, maxPixels);
  let start = 0, win = new Uint8Array(0);
  const ensure = async (at, need) => {
    if (at >= start && at + Math.min(need, input.size - at) <= start + win.length) return;
    start = at; win = await blobBytes(input, signal, at, at + 65536);
    check(signal);
  };
  const byte = at => win[at - start];
  let p = 13 + (head[10] & 0x80 ? 3 << ((head[10] & 7) + 1) : 0), images = 0;
  while (p < input.size) {
    await ensure(p, 11);
    if (p >= start + win.length) break;
    const tag = byte(p++);
    if (tag === 0x3B) break;
    if (tag === 0x21) {
      p++;
      while (p < input.size) {
        await ensure(p, 1);
        if (p >= start + win.length) break;
        const sz = byte(p++);
        if (!sz) break;
        p += sz;
      }
      continue;
    }
    if (tag !== 0x2C || p + 9 > input.size) break;
    await ensure(p, 9);
    if (p + 9 > start + win.length) break;
    if (images++) throw fail('JXL_UNSUPPORTED', "animated GIF: use jpegxl/animation");
    const le16 = i => byte(i) | byte(i + 1) << 8;
    width = Math.max(width, le16(p) + le16(p + 4));
    height = Math.max(height, le16(p + 2) + le16(p + 6));
    if (!width || !height) throw fail('JXL_INPUT', 'GIF dimensions: invalid; pass a non-empty GIF');
    dimensions(width, height, maxPixels);
    const fpack = byte(p + 8);
    p += 9 + (fpack & 0x80 ? 3 << ((fpack & 7) + 1) : 0) + 1;
    while (p < input.size) {
      await ensure(p, 1);
      if (p >= start + win.length) break;
      const sz = byte(p++);
      if (!sz) break;
      p += sz;
    }
  }
  if (!width || !height) throw fail('JXL_INPUT', 'GIF dimensions: invalid; pass a non-empty GIF');
  dimensions(width, height, maxPixels);
}
const BMP_DIB_SIZES = new Set([12, 16, 40, 52, 56, 64, 108, 124]);
function bmpDimensions(head, maxPixels) {
  if (head.length < 22) throw fail('JXL_INPUT', 'BMP header: incomplete; pass a complete BMP file');
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength), hdrSize = view.getUint32(14, true), core = hdrSize === 12;
  if (!BMP_DIB_SIZES.has(hdrSize) || !core && head.length < 26)
    throw fail('JXL_INPUT', 'BMP header: invalid; pass a valid BMP file');
  if (core) {
    const width = view.getUint16(18, true), height = view.getUint16(20, true);
    if (!width || !height) throw fail('JXL_INPUT', 'BMP dimensions: invalid');
    dimensions(width, height, maxPixels);
    return;
  }
  const rawW = view.getInt32(18, true), rawH = view.getInt32(22, true);
  if (rawW <= 0 || rawH === 0 || rawH === -2147483648) throw fail('JXL_INPUT', 'BMP dimensions: invalid');
  dimensions(rawW, Math.abs(rawH), maxPixels);
}

function inputHint(input) {
  if ((input instanceof ArrayBuffer ? input : ArrayBuffer.isView(input) ? input.buffer : null)?.detached) return 'The ArrayBuffer is detached; pass a live one.';
  const passed = filePassed(input);
  if (passed) return passed;
  return unreadInput(input);
}

export function pixels(input, options, maxPixels, half = false) {
  const result = surface(input, {maxPixels, readAs: options?.readAs, half});
  if (!result || !ArrayBuffer.isView(result.data) || result.data instanceof DataView)
    throw fail('JXL_INPUT', inputHint(input));
  for (const side of ['width', 'height']) if (result[side] === undefined) {
    throw fail('JXL_INPUT', filePassed(result.data) ?? `${side}: {data, width, height}`);
  }
  dimensions(result.width, result.height, maxPixels);
  return result;
}

export function jpegDimensions(input, maxPixels, maxDimension) {
  const scan = sizeScan(input.length, maxPixels, maxDimension), get = at => input[at];
  for (let step = scan.next(); !step.done; step = scan.next(get));
}

export async function jpegBlobDimensions(blob, maxPixels, signal, maxDimension) {
  await scanJpegBlob(blob, signal, sizeScan(blob.size, maxPixels, maxDimension));
}

export const jpegInfo = ((typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) || (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true)) ? null : function jpegInfo(input, maxPixels) {
  const scan = frameScan(input.length, maxPixels), get = at => input[at];
  let step = scan.next();
  while (!step.done) step = scan.next(get);
  return step.value;
};

export const jpegBlobInfo = ((typeof __RAPIER_JXL_CAPTURE_LEAN__ !== 'undefined' && __RAPIER_JXL_CAPTURE_LEAN__ === true) || (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true)) ? null : (blob, maxPixels, signal) => scanJpegBlob(blob, signal, frameScan(blob.size, maxPixels));

async function scanJpegBlob(blob, signal, scan) {
  let start = 0, window = new Uint8Array(0);
  const get = at => window[at - start];
  let step = scan.next();
  for (; !step.done; step = scan.next(get)) {
    const at = step.value;
    if (at >= start && at + 16 <= start + window.length) continue;
    start = at; window = await blobBytes(blob, signal, at, at + 4096);
    check(signal);
  }
  return step.value;
}

export async function admitJpeg(blob, maxPixels, signal) {
  try { await jpegBlobDimensions(blob, maxPixels, signal); }
  catch (error) { check(signal); if (error?.code !== 'JXL_JPEG') throw error; }
}

const NOT_JPEG = "JPEG signature", BAD_MARKER = "JPEG marker",
  DEFERRED = "JPEG deferred height: use host pixels",
  NO_SIZE = "JPEG dimensions: missing or truncated";
const SOF = [192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207];
function* sizeScan(length, maxPixels, maxDimension) {
  let input = yield 0;
  if (input(0) !== 255 || input(1) !== 216) throw fail('JXL_JPEG', NOT_JPEG);
  for (let at = 2; at < length;) {
    input = yield at;
    if (input(at++) !== 255) throw fail('JXL_JPEG', BAD_MARKER);
    while (input(at) === 255) input = yield ++at;
    const marker = input(at++);
    if (marker === 217 || marker === 218) break;
    if (marker === 1 || marker >= 208 && marker <= 215) continue;
    if (at + 2 > length) break;
    const size = input(at) * 256 + input(at + 1);
    if (size < 2 || at + size > length) break;
    if (SOF.includes(marker)) {
      if (size < 8) break;
      input = yield at;
      const width = input(at + 5) * 256 + input(at + 6), height = input(at + 3) * 256 + input(at + 4);
      if (!width || !height) throw fail('JXL_JPEG', DEFERRED);
      return dimensions(width, height, maxPixels, maxDimension);
    }
    at += size;
  }
  throw fail('JXL_JPEG', NO_SIZE);
}
function* frameScan(length, maxPixels) {
  let input = yield 0;
  if (input(0) !== 255 || input(1) !== 216) throw fail('JXL_JPEG', NOT_JPEG);
  let frame = null, jfif = false, adobeTransform = -1, hasICC = false;
  for (let at = 2; at < length;) {
    input = yield at;
    if (input(at++) !== 255) throw fail('JXL_JPEG', BAD_MARKER);
    while (input(at) === 255) input = yield ++at;
    const marker = input(at++);
    if (marker === 217) break;
    if (marker === 218) {
      if (!frame || at + 3 > length) break;
      input = yield at;
      const size = input(at) * 256 + input(at + 1), count = input(at + 2), ids = [];
      if (!count || size !== 6 + count * 2 || at + size > length)
        throw fail('JXL_JPEG', "JPEG scan components");
      for (let i = 0; i < count; i++) { input = yield at + 3 + i * 2; ids.push(input(at + 3 + i * 2)); }
      input = yield at + size - 3;
      const allComponentsInFirstScan = ids.length === frame.components.length &&
        new Set(ids).size === ids.length && frame.components.every(c => ids.includes(c.id));
      const sequential = [192, 193].includes(frame.marker) && allComponentsInFirstScan &&
        input(at + size - 3) === 0 && input(at + size - 2) === 63 && input(at + size - 1) === 0;
      return jpegSummary(frame, length, {firstScanComponents: count, allComponentsInFirstScan, sequential}, jfif, adobeTransform, hasICC);
    }
    if (marker === 1 || marker >= 208 && marker <= 215) continue;
    if (at + 2 > length) break;
    const size = input(at) * 256 + input(at + 1);
    if (size < 2 || at + size > length) break;
    if (marker === 224 && size >= 6) {
      input = yield at + 2;
      if (input(at + 2) === 74 && input(at + 3) === 70 && input(at + 4) === 73 && input(at + 5) === 70) jfif = true;
    } else if (marker === 226 && size >= 16 && !hasICC) {
      input = yield at + 2;
      const tag = 'ICC_PROFILE\0';
      let matches = true;
      for (let i = 0; i < tag.length; i++) if (input(at + 2 + i) !== tag.charCodeAt(i)) matches = false;
      hasICC = matches;
    } else if (marker === 238 && size >= 14) {
      input = yield at + 2;
      if (input(at + 2) === 65 && input(at + 3) === 100 && input(at + 4) === 111 && input(at + 5) === 98 && input(at + 6) === 101)
        adobeTransform = input(at + 13);
    }
    if (marker === 219) {
      const end = at + size;
      for (let p = at + 2; p < end;) {
        input = yield p;
        const kind = input(p++), precision = kind >> 4, id = kind & 15;
        if (precision > 1 || id > 3 || p + 64 * (precision + 1) > end)
          throw fail('JXL_JPEG', "quantization table");
        for (let k = 0; k < 64; k++, p += precision + 1) {
          if ((k & 7) === 0) input = yield p;
          const value = precision ? input(p) * 256 + input(p + 1) : input(p);
          if (!(value > 0)) throw fail('JXL_JPEG', "quantization value: nonzero");
        }
      }
    }
    if (SOF.includes(marker)) {
      if (size < 8) break;
      input = yield at;
      const width = input(at + 5) * 256 + input(at + 6), height = input(at + 3) * 256 + input(at + 4);
      if (!width || !height) throw fail('JXL_JPEG', DEFERRED);
      dimensions(width, height, maxPixels);
      const precision = input(at + 2), count = input(at + 7), components = [];
      if (!count || size !== 8 + count * 3) throw fail('JXL_JPEG', "JPEG frame components");
      for (let p = at + 8; p < at + size; p += 3) {
        input = yield p;
        const hv = input(p + 1);
        components.push({id: input(p), h: hv >> 4, v: hv & 15});
      }
      frame = {width, height, precision, components, marker};
    }
    at += size;
  }
  throw fail('JXL_JPEG', NO_SIZE);
}

function jpegSummary({width, height, precision, components, marker}, sourceBytes, scan, jfif, adobeTransform, hasICC) {
  const [y, cb, cr] = components, sameChroma = components.length === 3 && cb.h === cr.h && cb.v === cr.v;
  const subsampling = components.length === 1 ? 'gray' : !sameChroma ? 'other'
    : y.h === cb.h && y.v === cb.v ? '444' : y.h === cb.h * 2 && y.v === cb.v * 2 ? '420'
    : y.h === cb.h * 2 && y.v === cb.v ? '422' : 'other';
  const ycbcr = components.length === 3 && jpegYCbCr(components, jfif, adobeTransform) &&
    components.every((c, i) => c.id === i + 1) && (adobeTransform < 0 || adobeTransform === 1);
  return {width, height, precision, components: components.length, subsampling, progressive: marker === 194, sourceBytes, ycbcr, hasICC, ...scan};
}
