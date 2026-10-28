import {JxlBits} from '../decode-bits.mjs';
import {readDecodeImageHeader} from '../decode-header.mjs';
import {inspectContainer} from '../decode-container.mjs';
import {fail} from './primitives.mjs';
export function header(bytes, options = {}) {
  const maxBytes = options.maxInputBytes ?? 1073741824;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw fail('JXL_OPTIONS', 'maxInputBytes is a positive safe integer.');
  if (bytes.byteLength > maxBytes) throw fail('JXL_LIMIT', 'Encoded input exceeds maxInputBytes.');
  const stream = bytes[0] === 255 && bytes[1] === 10 ? bytes : inspectContainer(bytes, {maxBytes}).codestream;
  return readDecodeImageHeader(new JxlBits(stream), {maxPixels: 40000000, maxSamples: 268435456, maxMetadataBytes: 67108864, ...options});
}
