// SPDX-License-Identifier: MIT
import {LIMITS} from './bits.mjs';
import {fault, guard, admitOutputSize} from './admit.mjs';

import {SIGNATURE, FTYP, BRAND, CODESTREAM, EXIF, XML, RECONSTRUCTION, boxes} from './container.mjs';

const invalid = message => fault('JXL_INPUT', message);

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

export function withMetadata(bytes, options = {}) { return guard(() => attach(bytes, options)); }
