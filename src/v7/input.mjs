// SPDX-License-Identifier: MIT
import {check, fail} from './primitives.mjs';
import {image as imageWith, nativeBitmap, requirePNGReader} from './input-native.mjs';
export {pixels, jpegDimensions, jpegBlobDimensions, admitJpeg} from './input-native.mjs';

export const image = (input, options, hooks = {}) => imageWith(input, options, hooks, readBlob);
async function readBlob(input, options, hooks, head, png) {
  if (png) {
    const depth = head[24], colourType = head[25];
    if (depth === 16 || hooks.deep && options?.readAs === undefined && (colourType === 4 || colourType === 6 ||
        typeof createImageBitmap !== 'function' || await transparencyChunk(input, hooks.signal) !== false)) {
      requirePNGReader(options, hooks);
      const {readSource, orient} = await hooks.deep();
      const result = await readSource(new Uint8Array(await input.arrayBuffer()));
      check(hooks.signal);
      return orient(result, {signal: hooks.signal, maxPixels: hooks.maxPixels});
    }
  }
  return nativeBitmap(input, options, hooks, {
    prepare: () => hooks.phone?.(input, head, hooks),
    platform: () => hooks.deep ? 'Pass RGBA pixels, a 16-bit or transparent PNG Blob, or use recompress.' : undefined,
    blob: phone => phone?.decodeBlob,
    failure: phone => phone ? 'This browser cannot decode the phone image; pass RGBA pixels. ' : undefined,
    admit(bitmap, phone) {
      if (phone && (bitmap.width !== phone.width || bitmap.height !== phone.height))
        throw fail('JXL_INPUT', 'The native decoder returned the phone image at the wrong size.');
    },
  });
}

async function transparencyChunk(blob, signal) {
  for (let offset = 8, n = 0; n < 64; n++) {
    if (offset + 8 > blob.size) return false;
    const head = new DataView(await blob.slice(offset, offset + 8).arrayBuffer());
    check(signal);
    if (head.byteLength < 8) return false;
    const name = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
    if (name === 'tRNS') return true;
    if (name === 'IDAT' || name === 'IEND') return false;
    offset += 12 + head.getUint32(0);
  }
  return 'unknown';
}

