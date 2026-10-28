import {check, dimensions, fail} from './primitives.mjs';
import {surface} from './surface.mjs';

export async function image(input, options, hooks = {}) {
  check(hooks.signal);
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    const head = new Uint8Array(await input.slice(0, 32).arrayBuffer());
    check(hooks.signal);
    if ([137,80,78,71,13,10,26,10].every((byte, i) => head[i] === byte)) {
      if (head.length < 29 || head[12] !== 73 || head[13] !== 72 || head[14] !== 68 || head[15] !== 82)
        throw fail('JXL_INPUT', 'The PNG header is incomplete.');
      const view = new DataView(head.buffer);
      dimensions(view.getUint32(16), view.getUint32(20), hooks.maxPixels);
      if (head[24] === 16) {
        const {readSource} = await import('../source.mjs');
        const result = await readSource(new Uint8Array(await input.arrayBuffer()));
        check(hooks.signal);
        return result;
      }
    } else if (head[0] === 255 && head[1] === 216) {
      jpegDimensions(new Uint8Array(await input.arrayBuffer()), hooks.maxPixels);
      check(hooks.signal);
    }
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function')
      throw fail('JXL_PLATFORM', 'This input needs a native image decoder. Supply RGBA pixels, a 16-bit PNG Blob, or use JPEG recompression.');
    const bitmap = await createImageBitmap(input);
    try {
      check(hooks.signal); dimensions(bitmap.width, bitmap.height, hooks.maxPixels);
      return surface(bitmap, {maxPixels: hooks.maxPixels, colorSpace: options?.colorSpace});
    } finally { bitmap.close(); }
  }
  const result = surface(input, {maxPixels: hooks.maxPixels, colorSpace: options?.colorSpace});
  if (!result || !ArrayBuffer.isView(result.data) || result.data instanceof DataView)
    throw fail('JXL_INPUT', 'Pixels must be {data, width, height}; use recompress for JPEG bytes.');
  dimensions(result.width, result.height, hooks.maxPixels);
  return result;
}

export function jpegDimensions(input, maxPixels) {
  if (input[0] !== 255 || input[1] !== 216) throw fail('JXL_JPEG', 'Input is not a JPEG.');
  for (let at = 2; at < input.length;) {
    if (input[at++] !== 255) throw fail('JXL_JPEG', 'Invalid JPEG marker.');
    while (input[at] === 255) at++;
    const marker = input[at++];
    if (marker === 217 || marker === 218) break;
    if (marker === 1 || marker >= 208 && marker <= 215) continue;
    if (at + 2 > input.length) break;
    const size = input[at] * 256 + input[at + 1];
    if (size < 2 || at + size > input.length) break;
    if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
      if (size < 8) break;
      dimensions(input[at + 5] * 256 + input[at + 6], input[at + 3] * 256 + input[at + 4], maxPixels);
      return;
    }
    at += size;
  }
  throw fail('JXL_JPEG', 'JPEG dimensions are missing or truncated.');
}
