// SPDX-License-Identifier: MIT
import {BitWriter, float16Bits, LIMITS} from './bits.mjs';
import {fault, admitOutputSize} from './admit.mjs';
import {readImageHeader, copyBits} from './framing.mjs';
import {JxlBits, skipICC} from './jpeg-coefficients.mjs';
import {SIGNATURE, CODESTREAM, PARTIAL, boxHeader} from './container.mjs';
import {inspectContainer, readFrameIndex, withFrameIndex} from './container-advanced.mjs';
import {prepareUpsamplingWeights} from './format-fields.mjs';

export {LIMITS};
export const DEFAULT_OPSIN = Object.freeze({
  inverseMatrix: Object.freeze([11.031566901960783, -9.866943921568629, -0.16462299647058826,
    -3.254147380392157, 4.418770392156863, -0.16462299647058826,
    -3.6588512862745097, 2.7129230470588235, 1.9459282392156863]),
  opsinBiases: Object.freeze(Array(3).fill(-0.0037930732552754493)),
  quantizationBiases: Object.freeze([0.945349926692846, 0.9299455010825141, 0.9500648966626563, 0.145]),
});
const opsinError = message => fault('JXL_INPUT', message);
function opsinOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw opsinError('Opsin options are an object.');
  if (value.reset !== undefined && typeof value.reset !== 'boolean') throw opsinError('Opsin reset is boolean.');
  if (value.reset && ['inverseMatrix', 'opsinBiases', 'quantizationBiases'].some(name => value[name] !== undefined))
    throw opsinError('Reset cannot also replace custom opsin fields.');
  if (value.inverseMatrix !== undefined) opsinMatrix(value.inverseMatrix);
  if (value.opsinBiases !== undefined) opsinValues(value.opsinBiases, 3, 'Opsin biases');
  if (value.quantizationBiases !== undefined) opsinValues(value.quantizationBiases, 4, 'Quantization biases');
}
function opsinValues(value, length, label) {
  if (!value || typeof value !== 'object' || value.length !== length) throw opsinError(label + ' has ' + length + ' finite values.');
  return Array.from(value, number => {
    if (typeof number !== 'number' || !Number.isFinite(number) || Math.abs(number) >= 65520)
      throw opsinError(label + ' values must round to finite binary16 numbers.');
    return number;
  });
}
function opsinMatrix(value) {
  if (Array.isArray(value) && value.length === 3 && value.every(row => row && typeof row === 'object' && row.length === 3))
    value = value.flatMap(row => Array.from(row));
  return opsinValues(value, 9, 'The inverse opsin matrix');
}
function opsinData(options, existing) {
  const weights = options.upsamplingWeights === undefined ? existing?.weights : prepareUpsamplingWeights(options.upsamplingWeights);
  const custom = !options.reset && (existing?.custom || ['inverseMatrix', 'opsinBiases', 'quantizationBiases'].some(name => options[name] !== undefined));
  const writer = new BitWriter(64);
  if (!custom && !weights) { writer.write(1, 1); return writer; }
  writer.write(1, 0); writer.write(1, custom ? 0 : 1);
  if (custom) {
    const matrix = opsinMatrix(options.inverseMatrix ?? existing?.inverseMatrix ?? DEFAULT_OPSIN.inverseMatrix);
    const biases = opsinValues(options.opsinBiases ?? existing?.opsinBiases ?? DEFAULT_OPSIN.opsinBiases, 3, 'Opsin biases');
    const quant = opsinValues(options.quantizationBiases ?? existing?.quantizationBiases ?? DEFAULT_OPSIN.quantizationBiases, 4, 'Quantization biases');
    for (const value of [...matrix, ...biases, ...quant]) writer.write(16, float16Bits(value));
  }
  if (weights) copyBits(writer, weights.finish(), 1, weights.bitLength);
  else writer.write(3, 0);
  return writer;
}
export function prepareOpsinTransform(options = {}) { opsinOptions(options); return opsinData(options); }

function opsinHalf(bits) {
  const sign = bits & 32768 ? -1 : 1, exponent = bits >> 10 & 31, mantissa = bits & 1023;
  if (exponent === 31) throw opsinError('Nonfinite existing opsin fields are unsupported.');
  let value = exponent ? 1 + mantissa / 1024 : mantissa / 1024;
  let power = exponent ? exponent - 15 : -14;
  while (power > 0) { value *= 2; power--; } while (power < 0) { value /= 2; power++; }
  return sign * value;
}
function readOpsinFields(bytes, image) {
  const r = new JxlBits(bytes); r.bit = image.transformAt;
  if (r.read(1)) return {custom: false};
  const custom = !r.read(1), fields = {custom};
  if (custom) {
    fields.inverseMatrix = Array.from({length: 9}, () => opsinHalf(r.read(16)));
    fields.opsinBiases = Array.from({length: 3}, () => opsinHalf(r.read(16)));
    fields.quantizationBiases = Array.from({length: 4}, () => opsinHalf(r.read(16)));
  }
  const start = r.bit, mask = r.read(3);
  if (mask) { const weights = new BitWriter(128); weights.write(1, 0); copyBits(weights, bytes, start, image.iccAt); fields.weights = weights; }
  return fields;
}
function opsinICCSpan(bytes, at) { const reader = new JxlBits(bytes); reader.bit = at; skipICC(reader); return reader.bit - at; }
export function withOpsin(bytes, options = {}) {
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw opsinError('Opsin input is a nonempty JPEG XL Uint8Array.');
  admitOutputSize(bytes.length);
  opsinOptions(options);
  const raw = bytes[0] === 255 && bytes[1] === 10, source = raw ? null : inspectContainer(bytes);
  const codestream = raw ? bytes : source.codestream, image = readImageHeader(codestream, {iccBits: opsinICCSpan});
  if (!image.xyb) throw opsinError('Custom inverse opsin applies only to an XYB-encoded image.');
  if (!options.reset && !['inverseMatrix', 'opsinBiases', 'quantizationBiases', 'upsamplingWeights'].some(name => options[name] !== undefined)) return bytes.slice();
  if (source?.auxiliary.some(box => box.boxType === 'jbrd')) throw opsinError('Custom opsin does not apply to a JPEG reconstruction stream.');
  const index = source?.auxiliary.some(box => box.boxType === 'jxli') ? readFrameIndex(bytes) : null;
  if (index?.frames.some(frame => frame.byteOffset < image.end)) throw opsinError('A frame index must point after the image header.');
  const fields = opsinData(options, readOpsinFields(codestream, image)), head = new BitWriter(256);
  copyBits(head, codestream, 0, image.transformAt); head.append(fields);
  copyBits(head, codestream, image.iccAt, image.payloadEnd); head.zeroPadToByte();
  const header = head.finish(), length = header.length + codestream.length - image.end;
  admitOutputSize(length);
  const stream = new Uint8Array(length); stream.set(header); stream.set(codestream.subarray(image.end), header.length);
  if (raw) return stream;
  const parts = [SIGNATURE], view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let written = false;
  for (let at = 12; at < bytes.length;) {
    const short = view.getUint32(at), type = view.getUint32(at + 4);
    const size = short === 1 ? view.getUint32(at + 8) * 4294967296 + view.getUint32(at + 12) : short || bytes.length - at;
    if (type === CODESTREAM || type === PARTIAL) {
      if (!written) { parts.push(boxHeader(CODESTREAM, stream.length), stream); written = true; }
    } else parts.push(bytes.subarray(at, at + size));
    at += size;
  }
  const outputLength = parts.reduce((total, part) => total + part.length, 0); admitOutputSize(outputLength);
  const output = new Uint8Array(outputLength); let at = 0;
  for (const part of parts) { output.set(part, at); at += part.length; }
  if (!index) return output;
  const delta = header.length - image.end;
  return withFrameIndex(output, {...index, frames: index.frames.map(frame => ({...frame,
    byteOffset: typeof frame.byteOffset === 'bigint' ? frame.byteOffset + BigInt(delta) : frame.byteOffset + delta}))});
}
