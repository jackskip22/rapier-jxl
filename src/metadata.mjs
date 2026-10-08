// SPDX-License-Identifier: MIT
import {LIMITS} from './bits.mjs';
import {fault, guard, admitOutputSize} from './admit.mjs';

const SIGNATURE = new Uint8Array([0, 0, 0, 12, 74, 88, 76, 32, 13, 10, 135, 10]);
const FTYP = 0x66747970, BRAND = 0x6a786c20, CODESTREAM = 0x6a786c63, PARTIAL = 0x6a786c70;
const EXIF = 0x45786966, XML = 0x786d6c20, BROB = 0x62726f62, RECONSTRUCTION = 0x6a627264;
const invalid = message => fault('JXL_INPUT', message);

// Framing and fragment validation does not decode the image or compressed metadata.
function* boxes(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let first = true, next = 0, complete = false, stream = 0;
  for (let at = SIGNATURE.length; at < bytes.length;) {
    if (bytes.length - at < 8) throw invalid('Truncated JPEG XL box header.');
    let length = view.getUint32(at), body = at + 8;
    const type = view.getUint32(at + 4);
    if (length === 1) {
      if (bytes.length - at < 16) throw invalid('Truncated extended JPEG XL box header.');
      length = view.getUint32(at + 8) * 4294967296 + view.getUint32(at + 12); body += 8;
    } else if (!length) length = bytes.length - at;
    if (!Number.isSafeInteger(length) || length < body - at || length > bytes.length - at) throw invalid('Invalid JPEG XL box size.');
    const end = at + length;
    if (first) {
      if (type !== FTYP || end - body < 12 || (end - body) % 4 || view.getUint32(body) !== BRAND || view.getUint32(body + 4) > 1)
        throw invalid('The second JPEG XL box must declare the jxl file type.');
      let compatible = false;
      for (let p = body + 8; p < end; p += 4) compatible ||= view.getUint32(p) === BRAND;
      if (!compatible) throw invalid('The JPEG XL file type lacks the jxl compatibility brand.');
      first = false;
    } else if (type === FTYP || type === 0x4a584c20) throw invalid('Repeated JPEG XL file header.');
    let decoded = type;
    if (type === BROB) {
      if (end - body < 4) throw invalid('Truncated compressed JPEG XL metadata.');
      decoded = view.getUint32(body);
    }
    if (type === CODESTREAM || type === PARTIAL) {
      if (complete || type === CODESTREAM && next) throw invalid('Repeated or mixed JPEG XL codestream boxes.');
      let data = body;
      if (type === PARTIAL) {
        if (end - body < 4) throw invalid('Truncated JPEG XL codestream fragment.');
        const index = view.getUint32(body); data += 4;
        if ((index & 0x7fffffff) !== next++) throw invalid('JPEG XL codestream fragments are out of order.');
        complete = !!(index & 0x80000000);
      } else complete = true;
      while (data < end && stream < 2) {
        if (bytes[data++] !== (stream++ ? 10 : 255)) throw invalid('Invalid JPEG XL codestream signature.');
      }
    }
    yield {at, end, body, type, decoded};
    at = end;
  }
  if (first || !complete || stream < 2) throw invalid('The JPEG XL container has no complete codestream.');
}

function utf8Length(text) {
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128) length++;
    else if (c < 2048) length += 2;
    else if (c >= 0xd800 && c <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { length += 4; i++; }
    else length += 3;
    if (length > LIMITS.bytes) admitOutputSize(length);
  }
  return length;
}

function attach(bytes, options) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 2) throw invalid('JPEG XL input is a Uint8Array.');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw invalid('Metadata options are an object: {exif, xmp}.');
  const {exif, xmp} = options, hasExif = exif !== undefined, hasXmp = xmp !== undefined, edited = hasExif || hasXmp;
  const writeExif = hasExif && exif !== null, writeXmp = hasXmp && xmp !== null;
  if (writeExif && (!(exif instanceof Uint8Array) || exif.length < 8 ||
    !(exif[0] === 73 && exif[1] === 73 && exif[2] === 42 && exif[3] === 0 || exif[0] === 77 && exif[1] === 77 && exif[2] === 0 && exif[3] === 42)))
    throw invalid('Exif is raw TIFF bytes, starting with II or MM; omit the JPEG APP1 header.');
  if (writeXmp && typeof xmp !== 'string' && !(xmp instanceof Uint8Array)) throw invalid('XMP is a UTF-8 string or Uint8Array.');
  const xmpLength = typeof xmp === 'string' ? utf8Length(xmp) : writeXmp ? xmp.length : 0;
  const added = (writeExif ? exif.length + 12 : 0) + (writeXmp ? xmpLength + 8 : 0);
  admitOutputSize(added);
  const bare = bytes[0] === 255 && bytes[1] === 10, replace = type => type === EXIF && hasExif || type === XML && hasXmp;
  let length = bytes.length + added, prefix = 0;
  if (bare) { if (added) length += 40; }
  else {
    if (bytes.length < SIGNATURE.length || !SIGNATURE.every((byte, i) => bytes[i] === byte)) throw invalid('Invalid JPEG XL signature.');
    for (const box of boxes(bytes)) {
      if (box.type === FTYP) prefix = box.end;
      if (edited && box.decoded === RECONSTRUCTION) throw invalid('Metadata edits would invalidate JPEG reconstruction data; retain the original JPEG XL file.');
      if (replace(box.decoded)) length -= box.end - box.at;
    }
  }
  admitOutputSize(length);
  const output = new Uint8Array(length), view = new DataView(output.buffer);
  if (!edited || bare && !added) { output.set(bytes); return output; }
  let at = 0;
  const header = (type, size) => { view.setUint32(at, size); view.setUint32(at + 4, type); at += 8; };
  if (bare) {
    output.set(SIGNATURE); at = SIGNATURE.length;
    header(FTYP, 20); view.setUint32(at, BRAND); view.setUint32(at + 8, BRAND); at += 12;
  } else { output.set(bytes.subarray(0, prefix)); at = prefix; }
  if (writeExif) { header(EXIF, exif.length + 12); at += 4; output.set(exif, at); at += exif.length; }
  if (writeXmp) {
    header(XML, xmpLength + 8);
    if (typeof xmp === 'string') new TextEncoder().encodeInto(xmp, output.subarray(at, at + xmpLength));
    else output.set(xmp, at);
    at += xmpLength;
  }
  if (bare) { header(CODESTREAM, bytes.length + 8); output.set(bytes, at); }
  else for (const box of boxes(bytes)) if (box.type !== FTYP && !replace(box.decoded)) {
    output.set(bytes.subarray(box.at, box.end), at); at += box.end - box.at;
  }
  return output;
}

/** Attach, replace or remove Exif/XMP without changing image samples, color encoding or orientation. */
export function withMetadata(bytes, options = {}) { return guard(() => attach(bytes, options)); }
