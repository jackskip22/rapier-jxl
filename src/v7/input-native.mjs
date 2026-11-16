// SPDX-License-Identifier: MIT
import {check, dimensions, fail, blobBytes, unreadInput} from './primitives.mjs';
import {surface} from './surface.mjs';
import {jpegYCbCr} from '../jpeg-color.mjs';
import {browserRead} from './browser-resize.mjs';

export async function image(input, options, hooks = {}, readBlob = nativeBlob) {
  check(hooks.signal);
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    const head = await blobBytes(input, hooks.signal, 0, 32);
    check(hooks.signal);
    const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => head[i] === byte);
    if (png) {
      if (head.length < 29 || head[12] !== 73 || head[13] !== 72 || head[14] !== 68 || head[15] !== 82)
        throw fail('JXL_INPUT', "Incomplete PNG header; pass a valid PNG file.");
      const view = new DataView(head.buffer);
      dimensions(view.getUint32(16), view.getUint32(20), hooks.maxPixels);
      const chunks = await pngChunks(input, hooks.signal) ?? await pngChunks(input, hooks.signal, Infinity);
      if (chunks.names.has('acTL')) throw animated('PNG');
    } else if (head.length >= 16 && String.fromCharCode(...head.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...head.subarray(8, 12)) === 'WEBP')
      riffDimensions(head, hooks.maxPixels);
    else if (head[0] === 255 && head[1] === 216) await jpegBlobDimensions(input, hooks.maxPixels, hooks.signal);
    else if (head[0] === 71 && head[1] === 73 && head[2] === 70) await gifBlobDimensions(input, head, hooks.maxPixels, hooks.signal);
    else if (head[0] === 66 && head[1] === 77) bmpDimensions(head, hooks.maxPixels);
    return readBlob(input, options, hooks, head, png);
  }
  return pixels(input, options, hooks.maxPixels);
}

const animated = kind => fail('JXL_UNSUPPORTED', `This is an animated ${kind}: decode its frames and pass {width, height, frames} to rapier-jxl/animation.`);
function riffDimensions(head, maxPixels) {
  const kind = String.fromCharCode(...head.subarray(12, 16)), u24 = i => head[i] | head[i + 1] << 8 | head[i + 2] << 16;
  if (kind === 'VP8X') {
    if (head.length >= 21 && head[20] & 2) throw animated('WebP');
    if (head.length >= 30) dimensions(1 + u24(24), 1 + u24(27), maxPixels);
  } else if (kind === 'VP8L' && head.length >= 25 && head[20] === 0x2f) {
    const bits = head[21] | head[22] << 8 | head[23] << 16 | head[24] << 24;
    dimensions(1 + (bits & 0x3fff), 1 + (bits >>> 14 & 0x3fff), maxPixels);
  } else if (kind === 'VP8 ' && head.length >= 30 && !(head[20] & 1) && head[23] === 0x9d && head[24] === 0x01 && head[25] === 0x2a)
    dimensions(head[26] | (head[27] & 0x3f) << 8 || 1, head[28] | (head[29] & 0x3f) << 8 || 1, maxPixels);
}

export async function pngChunks(blob, signal, limit = 64) {
  const names = new Set();
  let intent, cicp;
  for (let offset = 8, n = 0; n < limit; n++) {
    if (offset + 8 > blob.size) return {names, intent, cicp};
    const head = new DataView((await blobBytes(blob, signal, offset, offset + 12)).buffer);
    check(signal);
    if (head.byteLength < 8) return {names, intent, cicp};
    const name = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
    if (name === 'IDAT' || name === 'IEND') return {names, intent, cicp};
    names.add(name);
    if (name === 'sRGB') intent = head.byteLength < 9 ? undefined : head.getUint8(8);
    if (name === 'cICP') cicp = head.byteLength < 12 ? undefined : [8, 9, 10, 11].map(i => head.getUint8(i));
    offset += 12 + head.getUint32(0);
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
  const icc = await blobBytes(new Blob(parts.map(part => blob.slice(part.start, part.end))), signal);
  const kept = [];
  let from = 0;
  for (const [start, end] of cuts) { kept.push(blob.slice(from, start)); from = end; }
  kept.push(blob.slice(from));
  return {icc, plain: new Blob(kept, {type: blob.type})};
};

export function requirePNGReader(options, hooks) {
  if (options?.readAs !== undefined) throw fail('JXL_OPTIONS', "A 16-bit PNG keeps its declared color; remove readAs.");
  if (!hooks?.deep) throw fail('JXL_INPUT', 'This encoder takes 8-bit samples; for 16-bit PNG use rapier-jxl.');
}
function nativeBlob(input, options, hooks, head, png) {
  if (png && head[24] === 16) requirePNGReader(options);
  return nativeBitmap(input, options, hooks);
}

export async function nativeBitmap(input, options, hooks, policy) {
  const prepared = await policy?.prepare?.();
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function')
    throw fail('JXL_PLATFORM', 'This host has no image decoder for this file; ' + (policy?.platform?.() ?? 'pass decoded 8-bit RGBA pixels.'));
  let bitmap;
  try {
    const source = policy?.blob?.(prepared) ?? input, region = policy?.region;
    bitmap = region ? await createImageBitmap(source, region.x, region.y, region.width, region.height, {imageOrientation: 'from-image'})
      : await createImageBitmap(source, {imageOrientation: 'from-image'});
  }
  catch (cause) { check(hooks.signal); throw Object.assign(fail('JXL_INPUT', policy?.failure?.(prepared) ?? 'The browser could not decode this image; pass a complete supported file or its RGBA pixels.'), {cause}); }
  try {
    check(hooks.signal); dimensions(bitmap.width, bitmap.height, hooks.maxPixels);
    policy?.admit?.(bitmap, prepared);
    const picture = surface(bitmap, {maxPixels: hooks.maxPixels, readAs: options?.readAs});
    if (!(typeof __RAPIER_JXL_CAPTURE_LEAN__ !== "undefined" && __RAPIER_JXL_CAPTURE_LEAN__ === true)) browserRead(picture.data);
    return picture;
  } finally { bitmap.close(); }
}

function scanGif(b, width, height, maxPixels) {
  const le16 = i => b[i] | b[i + 1] << 8;
  let p = 13 + (b[10] & 0x80 ? 3 << ((b[10] & 7) + 1) : 0), images = 0, complete = false;
  while (p < b.length) {
    const tag = b[p++];
    if (tag === 0x3B) { complete = true; break; }
    if (tag === 0x21) { p++; while (p < b.length && b[p]) p += b[p] + 1; p++; continue; }
    if (tag !== 0x2C || p + 8 >= b.length) { complete = tag !== 0x2C; break; }
    if (images++) throw fail('JXL_UNSUPPORTED', "GIF contains multiple frames; encode it with rapier-jxl/animation.");
    width = Math.max(width, le16(p) + le16(p + 4)); height = Math.max(height, le16(p + 2) + le16(p + 6));
    dimensions(width || 1, height || 1, maxPixels);
    p += 9 + (b[p + 8] & 0x80 ? 3 << ((b[p + 8] & 7) + 1) : 0) + 1;
    while (p < b.length && b[p]) p += b[p] + 1;
    p++;
  }
  return {width, height, complete};
}
async function gifBlobDimensions(input, head, maxPixels, signal) {
  const b = await blobBytes(input, signal, 0, 65536);
  check(signal);
  const {width, height, complete} = scanGif(b, head[6] | head[7] << 8, head[8] | head[9] << 8, maxPixels);
  dimensions(width || 1, height || 1, maxPixels);
  if (!complete && input.size > b.length) { const all = await blobBytes(input, signal); scanGif(all, width, height, maxPixels); }
}
function bmpDimensions(head, maxPixels) {
  if (head.length < 26) return;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength), core = view.getUint32(14, true) === 12;
  const width = core ? view.getUint16(18, true) : Math.abs(view.getInt32(18, true));
  const height = core ? view.getUint16(20, true) : Math.abs(view.getInt32(22, true));
  dimensions(width || 1, height || 1, maxPixels);
}

const FILES = [[[0x89, 0x50, 0x4e, 0x47], 'PNG'], [[0xff, 0xd8, 0xff], 'JPEG'], [[0x47, 0x49, 0x46, 0x38], 'GIF'], [[0x52, 0x49, 0x46, 0x46], 'WebP']];
function inputHint(input) {
  if ((input instanceof ArrayBuffer ? input : ArrayBuffer.isView(input) ? input.buffer : null)?.detached) return 'The ArrayBuffer is detached; pass a live one.';
  const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, Math.min(input.byteLength, 4))
    : input instanceof ArrayBuffer ? new Uint8Array(input, 0, Math.min(input.byteLength, 4)) : null;
  const kind = bytes && FILES.find(([magic]) => magic.every((byte, i) => bytes[i] === byte))?.[1];
  if (kind) return `These are ${kind} file bytes; pass new Blob([bytes]).`;
  return unreadInput(input);
}

export function pixels(input, options, maxPixels, half = false) {
  const result = surface(input, {maxPixels, readAs: options?.readAs, half});
  if (!result || !ArrayBuffer.isView(result.data) || result.data instanceof DataView)
    throw fail('JXL_INPUT', inputHint(input));
  for (const side of ['width', 'height']) if (result[side] === undefined)
    throw fail('JXL_INPUT', `Pixels need their ${side}: pass {data, width, height}.`);
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

const NOT_JPEG = "Input is not a JPEG; pass a valid JPEG file.", BAD_MARKER = "Invalid JPEG marker; pass a valid JPEG file.",
  DEFERRED = "JPEG defers its height to a scan marker; decode it with a host reader and pass its pixels.",
  NO_SIZE = "JPEG dimensions are missing or truncated; pass a valid JPEG file.";
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
  const tables = [];
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
        throw fail('JXL_JPEG', "Invalid JPEG scan components; pass a valid JPEG file.");
      for (let i = 0; i < count; i++) { input = yield at + 3 + i * 2; ids.push(input(at + 3 + i * 2)); }
      input = yield at + size - 3;
      const allComponentsInFirstScan = ids.length === frame.components.length &&
        new Set(ids).size === ids.length && frame.components.every(c => ids.includes(c.id));
      const sequential = [192, 193].includes(frame.marker) && allComponentsInFirstScan &&
        input(at + size - 3) === 0 && input(at + size - 2) === 63 && input(at + size - 1) === 0;
      return jpegSummary(frame, tables, length, {firstScanComponents: count, allComponentsInFirstScan, sequential}, jfif, adobeTransform, hasICC);
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
          throw fail('JXL_JPEG', "Invalid JPEG quantization table; pass a valid JPEG file.");
        let sum = 0, low = 0, dc;
        for (let k = 0; k < 64; k++, p += precision + 1) {
          if ((k & 7) === 0) input = yield p;
          const value = precision ? input(p) * 256 + input(p + 1) : input(p);
          if (!(value > 0)) throw fail('JXL_JPEG', "A JPEG quantization value is zero; pass a valid JPEG file.");
          if (k === 0) dc = value;
          else if (k <= 9) low += value;
          sum += value;
        }
        tables[id] = {dc, mean: sum / 64, low: low / 9, bits: precision ? 16 : 8};
      }
    }
    if (SOF.includes(marker)) {
      if (size < 8) break;
      input = yield at;
      const width = input(at + 5) * 256 + input(at + 6), height = input(at + 3) * 256 + input(at + 4);
      if (!width || !height) throw fail('JXL_JPEG', DEFERRED);
      dimensions(width, height, maxPixels);
      const precision = input(at + 2), count = input(at + 7), components = [];
      if (!count || size !== 8 + count * 3) throw fail('JXL_JPEG', "Invalid JPEG frame components; pass a valid JPEG file.");
      for (let p = at + 8; p < at + size; p += 3) {
        input = yield p;
        const hv = input(p + 1);
        components.push({id: input(p), h: hv >> 4, v: hv & 15, table: input(p + 2)});
      }
      frame = {width, height, precision, components, marker};
    }
    at += size;
  }
  throw fail('JXL_JPEG', NO_SIZE);
}

function jpegSummary({width, height, precision, components, marker}, tables, sourceBytes, scan, jfif, adobeTransform, hasICC) {
  const [y, cb, cr] = components, sameChroma = components.length === 3 && cb.h === cr.h && cb.v === cr.v;
  const subsampling = components.length === 1 ? 'gray' : !sameChroma ? 'other'
    : y.h === cb.h && y.v === cb.v ? '444' : y.h === cb.h * 2 && y.v === cb.v * 2 ? '420'
    : y.h === cb.h * 2 && y.v === cb.v ? '422' : 'other';
  const ycbcr = components.length === 3 && jpegYCbCr(components, jfif, adobeTransform) &&
    components.every((c, i) => c.id === i + 1) && (adobeTransform < 0 || adobeTransform === 1);
  const frame = {width, height, precision, components: components.length, subsampling, progressive: marker === 194, sourceBytes, ycbcr, hasICC, ...scan};
  if (![192, 193, 194].includes(marker) || ![1, 3].includes(components.length) ||
      components.some(c => !c.h || !c.v || !tables[c.table])) return frame;
  const luma = tables[y.table], chroma = cb ? (tables[cb.table].mean + tables[cr.table].mean) / 2 : luma.mean;
  return {...frame, yDC: luma.dc, yLow: luma.low, yMean: luma.mean, cMean: chroma,
    tableBits: Math.max(...components.map(c => tables[c.table].bits))};
}
