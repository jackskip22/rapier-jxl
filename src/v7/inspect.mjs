import {JxlBits} from '../decode-bits.mjs';
import {readDecodeImageHeader} from '../decode-header.mjs';
import {inspectContainer} from '../decode-container.mjs';
import {fail} from './primitives.mjs';
export function header(bytes, options = {}) {
  const maxBytes = options.maxInputBytes ?? 1073741824;
  const maxBoxes = options.maxBoxes ?? 65536;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw fail('JXL_OPTIONS', 'maxInputBytes is a positive safe integer.');
  if (!Number.isSafeInteger(maxBoxes) || maxBoxes < 1) throw fail('JXL_OPTIONS', 'maxBoxes is a positive safe integer.');
  if (bytes.byteLength > maxBytes) throw fail('JXL_LIMIT', 'Encoded input exceeds maxInputBytes.');
  const stream = bytes[0] === 255 && bytes[1] === 10 ? bytes : inspectContainer(bytes, {maxBytes, maxBoxes}).codestream;
  return readDecodeImageHeader(new JxlBits(stream), {maxPixels: 40000000, maxSamples: 268435456, maxMetadataBytes: 67108864, ...options});
}
