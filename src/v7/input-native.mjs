// SPDX-License-Identifier: MIT
import {check, dimensions, fail} from './primitives.mjs';
import {surface} from './surface.mjs';

export async function image(input, options, hooks = {}, readBlob = nativeBlob) {
  check(hooks.signal);
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    const head = new Uint8Array(await input.slice(0, 32).arrayBuffer());
    check(hooks.signal);
    const png = [137,80,78,71,13,10,26,10].every((byte, i) => head[i] === byte);
    if (png) {
      if (head.length < 29 || head[12] !== 73 || head[13] !== 72 || head[14] !== 68 || head[15] !== 82)
        throw fail('JXL_INPUT', 'The PNG header is incomplete.');
      const view = new DataView(head.buffer);
      dimensions(view.getUint32(16), view.getUint32(20), hooks.maxPixels);
    } else if (head[0] === 255 && head[1] === 216) await jpegBlobDimensions(input, hooks.maxPixels, hooks.signal);
    else if (head[0] === 71 && head[1] === 73 && head[2] === 70) await gifBlobDimensions(input, head, hooks.maxPixels, hooks.signal);
    else if (head[0] === 66 && head[1] === 77) bmpDimensions(head, hooks.maxPixels);
    return readBlob(input, options, hooks, head, png);
  }
  return pixels(input, options, hooks.maxPixels);
}

export function requirePNGReader(options, hooks) {
  if (options?.readAs !== undefined) throw fail('JXL_OPTIONS', 'readAs reads what the browser decodes; a 16-bit PNG keeps its depth and space.');
  if (!hooks?.deep) throw fail('JXL_INPUT', 'This encoder takes 8-bit samples; for 16-bit PNG use rapier-jxl.');
}
function nativeBlob(input, options, hooks, head, png) {
  if (png && head[24] === 16) requirePNGReader(options);
  return nativeBitmap(input, options, hooks);
}

export async function nativeBitmap(input, options, hooks, policy) {
  const prepared = await policy?.prepare?.();
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function')
    throw fail('JXL_PLATFORM', 'This input needs a native image decoder. ' + (policy?.platform?.() ?? 'Supply decoded 8-bit RGBA pixels.'));
  let bitmap;
  try {
    const source = policy?.blob?.(prepared) ?? input, region = policy?.region;
    bitmap = region ? await createImageBitmap(source,region.x,region.y,region.width,region.height,{imageOrientation:'from-image'})
      : await createImageBitmap(source,{imageOrientation:'from-image'});
  }
  catch (cause) { check(hooks.signal); throw Object.assign(fail('JXL_INPUT', (policy?.failure?.(prepared) ?? 'The browser could not decode this Blob: ') + (cause?.message || cause)), {cause}); }
  try {
    check(hooks.signal); dimensions(bitmap.width, bitmap.height, hooks.maxPixels);
    policy?.admit?.(bitmap, prepared);
    return surface(bitmap, {maxPixels: hooks.maxPixels, readAs: options?.readAs});
  } finally { bitmap.close(); }
}

async function gifBlobDimensions(input, head, maxPixels, signal) {
  const le16 = (b, i) => b[i] | b[i + 1] << 8;
  let width = le16(head, 6), height = le16(head, 8);
  const b = new Uint8Array(await input.slice(0, 65536).arrayBuffer());
  check(signal);
  let p = 13 + (b[10] & 0x80 ? 3 << ((b[10] & 7) + 1) : 0);
  while (p < b.length) {
    const tag = b[p++];
    if (tag === 0x21) { p++; while (p < b.length && b[p]) p += b[p] + 1; p++; continue; }
    if (tag === 0x2C && p + 8 < b.length) { width = Math.max(width, le16(b, p) + le16(b, p + 4)); height = Math.max(height, le16(b, p + 2) + le16(b, p + 6)); }
    break;
  }
  dimensions(width || 1, height || 1, maxPixels);
}
function bmpDimensions(head, maxPixels) {
  if (head.length < 26) return;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength), core = view.getUint32(14, true) === 12;
  const width = core ? view.getUint16(18, true) : Math.abs(view.getInt32(18, true));
  const height = core ? view.getUint16(20, true) : Math.abs(view.getInt32(22, true));
  dimensions(width || 1, height || 1, maxPixels);
}

export function pixels(input, options, maxPixels, half = false) {
  const result = surface(input, {maxPixels, readAs: options?.readAs, half});
  if (!result || !ArrayBuffer.isView(result.data) || result.data instanceof DataView)
    throw fail('JXL_INPUT', 'Pixels are {data, width, height}, ImageData, a canvas, a bitmap or an image Blob; recompress takes JPEG bytes.');
  dimensions(result.width, result.height, maxPixels);
  return result;
}

export function jpegDimensions(input, maxPixels) {
  const scan = frameScan(input.length, maxPixels), get = at => input[at];
  for (let step = scan.next(); !step.done; step = scan.next(get));
}

export async function jpegBlobDimensions(blob, maxPixels, signal) {
  const scan = frameScan(blob.size, maxPixels);
  let start = 0, window = new Uint8Array(0);
  const get = at => window[at - start];
  for (let step = scan.next(); !step.done; step = scan.next(get)) {
    const at = step.value;
    if (at >= start && at + 16 <= start + window.length) continue;
    start = at; window = new Uint8Array(await blob.slice(at, at + 4096).arrayBuffer());
    check(signal);
  }
}

export async function admitJpeg(blob, maxPixels, signal) {
  try { await jpegBlobDimensions(blob, maxPixels, signal); }
  catch (error) { check(signal); if (error?.code !== 'JXL_JPEG') throw error; }
}

function* frameScan(length, maxPixels) {
  let input = yield 0;
  if (input(0) !== 255 || input(1) !== 216) throw fail('JXL_JPEG', 'Input is not a JPEG.');
  for (let at = 2; at < length;) {
    input = yield at;
    if (input(at++) !== 255) throw fail('JXL_JPEG', 'Invalid JPEG marker.');
    while (input(at) === 255) input = yield ++at;
    const marker = input(at++);
    if (marker === 217 || marker === 218) break;
    if (marker === 1 || marker >= 208 && marker <= 215) continue;
    if (at + 2 > length) break;
    const size = input(at) * 256 + input(at + 1);
    if (size < 2 || at + size > length) break;
    if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
      if (size < 8) break;
      dimensions(input(at + 5) * 256 + input(at + 6), input(at + 3) * 256 + input(at + 4), maxPixels);
      return;
    }
    at += size;
  }
  throw fail('JXL_JPEG', 'JPEG dimensions are missing or truncated.');
}
