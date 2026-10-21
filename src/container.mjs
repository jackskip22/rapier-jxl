// SPDX-License-Identifier: MIT
import {fault, admitOutputSize} from './admit.mjs';

export const SIGNATURE = new Uint8Array([0, 0, 0, 12, 74, 88, 76, 32, 13, 10, 135, 10]);
export const FTYP = 0x66747970, BRAND = 0x6a786c20, CODESTREAM = 0x6a786c63, PARTIAL = 0x6a786c70;
export const EXIF = 0x45786966, XML = 0x786d6c20, BROB = 0x62726f62, RECONSTRUCTION = 0x6a627264;
export const JUMBF = 0x6a756d62, LEVEL = 0x6a786c6c;
const invalidBox = message => fault('JXL_INPUT', message);

export function boxHeader(type, length, wide = false) {
  if (!Number.isSafeInteger(length) || length < 0 || !Number.isInteger(type) || type < 0 || type > 0xffffffff)
    throw invalidBox('A JPEG XL box has a four-byte type and a nonnegative safe byte length.');
  const size = length + (wide || length > 0xffffffff - 8 ? 16 : 8);
  if (!Number.isSafeInteger(size)) throw invalidBox('The JPEG XL box length exceeds the safe integer range.');
  const out = new Uint8Array(wide || size > 0xffffffff ? 16 : 8), view = new DataView(out.buffer);
  view.setUint32(0, out.length === 16 ? 1 : size); view.setUint32(4, type);
  if (out.length === 16) { view.setUint32(8, Math.floor(size / 4294967296)); view.setUint32(12, size % 4294967296); }
  return out;
}

export function fileHeader(level = 5) {
  if (level !== 5 && level !== 10) throw invalidBox('The JPEG XL level is 5 or 10.');
  const out = new Uint8Array(level === 10 ? 41 : 32), view = new DataView(out.buffer);
  out.set(SIGNATURE); view.setUint32(12, 20); view.setUint32(16, FTYP); view.setUint32(20, BRAND); view.setUint32(28, BRAND);
  if (level === 10) { view.setUint32(32, 9); view.setUint32(36, LEVEL); out[40] = 10; }
  return out;
}

export function* boxes(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let first = true, next = 0, complete = false, stream = 0;
  for (let at = SIGNATURE.length; at < bytes.length;) {
    if (bytes.length - at < 8) throw invalidBox('Truncated JPEG XL box header.');
    let length = view.getUint32(at), body = at + 8;
    const type = view.getUint32(at + 4);
    if (length === 1) {
      if (bytes.length - at < 16) throw invalidBox('Truncated extended JPEG XL box header.');
      length = view.getUint32(at + 8) * 4294967296 + view.getUint32(at + 12); body += 8;
    } else if (!length) length = bytes.length - at;
    if (!Number.isSafeInteger(length) || length < body - at || length > bytes.length - at) throw invalidBox('Invalid JPEG XL box size.');
    const end = at + length;
    if (first) {
      if (type !== FTYP || end - body < 12 || (end - body) % 4 || view.getUint32(body) !== BRAND || view.getUint32(body + 4) > 1)
        throw invalidBox('The second JPEG XL box must declare the jxl file type.');
      let compatible = false;
      for (let p = body + 8; p < end; p += 4) compatible ||= view.getUint32(p) === BRAND;
      if (!compatible) throw invalidBox('The JPEG XL file type lacks the jxl compatibility brand.');
      first = false;
    } else if (type === FTYP || type === 0x4a584c20) throw invalidBox('Repeated JPEG XL file header.');
    let decoded = type;
    if (type === BROB) {
      if (end - body < 4) throw invalidBox('Truncated compressed JPEG XL metadata.');
      decoded = view.getUint32(body);
    }
    if (type === CODESTREAM || type === PARTIAL) {
      if (complete || type === CODESTREAM && next) throw invalidBox('Repeated or mixed JPEG XL codestream boxes.');
      let data = body;
      if (type === PARTIAL) {
        if (end - body < 4) throw invalidBox('Truncated JPEG XL codestream fragment.');
        const index = view.getUint32(body); data += 4;
        if ((index & 0x7fffffff) !== next++) throw invalidBox('JPEG XL codestream fragments are out of order.');
        complete = !!(index & 0x80000000);
      } else complete = true;
      while (data < end && stream < 2) {
        if (bytes[data++] !== (stream++ ? 10 : 255)) throw invalidBox('Invalid JPEG XL codestream signature.');
      }
    }
    yield {at, end, body, type, decoded};
    at = end;
  }
  if (first || !complete || stream < 2) throw invalidBox('The JPEG XL container has no complete codestream.');
}


export function withJPEGReconstruction(bytes, reconstruction) {
  if (!(bytes instanceof Uint8Array) || !(reconstruction instanceof Uint8Array))
    throw invalidBox('JPEG XL codestream and JPEG reconstruction data are Uint8Array values.');
  if (bytes[0] !== 255 || bytes[1] !== 10) {
    if (!SIGNATURE.every((byte, i) => bytes[i] === byte)) throw invalidBox('Invalid JPEG XL signature.');
    let insertion = -1;
    for (const entry of boxes(bytes)) {
      if (entry.decoded === RECONSTRUCTION) throw invalidBox('JPEG reconstruction data is already present.');
      if (insertion < 0 && (entry.type === CODESTREAM || entry.type === PARTIAL)) insertion = entry.at;
    }
    const header = boxHeader(RECONSTRUCTION, reconstruction.length), length = bytes.length + header.length + reconstruction.length;
    admitOutputSize(length);
    const output = new Uint8Array(length);
    output.set(bytes.subarray(0, insertion)); output.set(header, insertion); output.set(reconstruction, insertion + header.length);
    output.set(bytes.subarray(insertion), insertion + header.length + reconstruction.length);
    return output;
  }
  admitOutputSize(bytes.length + reconstruction.length + 48);
  const output = new Uint8Array(bytes.length + reconstruction.length + 48), view = new DataView(output.buffer);
  output.set(SIGNATURE); view.setUint32(12, 20); view.setUint32(16, FTYP); view.setUint32(20, BRAND); view.setUint32(28, BRAND);
  view.setUint32(32, reconstruction.length + 8); view.setUint32(36, RECONSTRUCTION); output.set(reconstruction, 40);
  const at = 40 + reconstruction.length;
  view.setUint32(at, bytes.length + 8); view.setUint32(at + 4, CODESTREAM); output.set(bytes, at + 8);
  return output;
}

export function jpegReconstruction(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 2) throw invalidBox('JPEG XL input is a Uint8Array.');
  admitOutputSize(bytes.length);
  if (bytes[0] === 255 && bytes[1] === 10) return null;
  if (!SIGNATURE.every((byte, i) => bytes[i] === byte)) throw invalidBox('Invalid JPEG XL signature.');
  let reconstruction = null;
  const parts = [];
  for (const box of boxes(bytes)) {
    if (box.decoded === RECONSTRUCTION) {
      if (reconstruction || box.type === BROB) throw invalidBox('Unsupported JPEG reconstruction box.');
      reconstruction = bytes.subarray(box.body, box.end);
    }
    if (box.type === CODESTREAM || box.type === PARTIAL) parts.push(bytes.subarray(box.body + (box.type === PARTIAL ? 4 : 0), box.end));
  }
  if (!reconstruction) return null;
  const codestream = parts.length === 1 ? parts[0] : new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  if (parts.length > 1) { let at = 0; for (const part of parts) { codestream.set(part, at); at += part.length; } }
  return {reconstruction, codestream};
}
