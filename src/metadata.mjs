// SPDX-License-Identifier: MIT
import {fault, guard, admitOutputSize} from './admit.mjs';
import {SIGNATURE, FTYP, LEVEL, CODESTREAM, EXIF, XML, JUMBF, BROB, RECONSTRUCTION, boxes, fileHeader, boxHeader} from './container.mjs';
import {compressBrotli, decompressBrotli} from './brotli.mjs';

const invalid = message => fault('JXL_INPUT', message);
const keys = new Map([[EXIF, 'exif'], [XML, 'xmp'], [JUMBF, 'jumb']]);
const tiff = bytes => bytes.length >= 8 && (bytes[0] === 73 && bytes[1] === 73 && bytes[2] === 42 && bytes[3] === 0 ||
  bytes[0] === 77 && bytes[1] === 77 && bytes[2] === 0 && bytes[3] === 42);

function utf8Length(text) {
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128) length++;
    else if (c < 2048) length += 2;
    else if (c >= 0xd800 && c <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { length += 4; i++; }
    else length += 3;
  }
  return length;
}

function sourceBoxes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 2) throw invalid('JPEG XL input is a Uint8Array.');
  admitOutputSize(bytes.length);
  if (bytes[0] === 255 && bytes[1] === 10) return null;
  if (!SIGNATURE.every((byte, i) => bytes[i] === byte)) throw invalid('Invalid JPEG XL signature.');
  return Array.from(boxes(bytes));
}

function prepare(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw invalid('Metadata options are an object: {exif, xmp, jumb}.');
  const changed = new Set(), entries = [];
  let total = 0;
  for (const [type, key] of keys) {
    const value = options[key];
    if (value === undefined) continue;
    changed.add(type);
    if (value === null) continue;
    const values = key === 'jumb' && Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (key === 'exif' && (!(item instanceof Uint8Array) || !tiff(item)))
        throw invalid('Exif is raw TIFF bytes, starting with II or MM; omit the JPEG APP1 header.');
      if (key === 'xmp' ? typeof item !== 'string' && !(item instanceof Uint8Array) : !(item instanceof Uint8Array))
        throw invalid(key === 'xmp' ? 'XMP is a UTF-8 string or Uint8Array.' : 'JUMBF is Uint8Array box contents or an array of those contents.');
      const length = (typeof item === 'string' ? utf8Length(item) : item.length) + (key === 'exif' ? 4 : 0);
      total += length + 8; admitOutputSize(total);
      const data = new Uint8Array(length);
      if (typeof item === 'string') new TextEncoder().encodeInto(item, data);
      else data.set(item, key === 'exif' ? 4 : 0);
      entries.push({type, decoded: type, data});
    }
  }
  return {changed, entries};
}

function attach(bytes, plan, source = sourceBoxes(bytes)) {
  const {changed, entries} = plan, edited = changed.size > 0;
  const added = entries.reduce((sum, entry) => sum + entry.data.length + 8, 0);
  let prefix = 0, length = bytes.length + added;
  if (source === null) { if (added) length += 40; }
  else for (const box of source) {
    if (box.type === FTYP || box.type === LEVEL && box.at === prefix) prefix = box.end;
    if (edited && box.decoded === RECONSTRUCTION) throw invalid('Metadata edits would invalidate JPEG reconstruction data; retain the original JPEG XL file.');
    if (changed.has(box.decoded)) length -= box.end - box.at;
  }
  admitOutputSize(length);
  if (!edited || source === null && !added) return new Uint8Array(bytes);
  const output = new Uint8Array(length);
  let at = source === null ? 32 : prefix;
  output.set(source === null ? fileHeader() : bytes.subarray(0, prefix));
  for (const entry of entries) {
    output.set(boxHeader(entry.type, entry.data.length), at); at += 8;
    output.set(entry.data, at); at += entry.data.length;
  }
  if (source === null) { output.set(boxHeader(CODESTREAM, bytes.length), at); output.set(bytes, at + 8); }
  else for (const box of source) if (box.at >= prefix && !changed.has(box.decoded)) {
    output.set(bytes.subarray(box.at, box.end), at); at += box.end - box.at;
  }
  return output;
}

export function withMetadata(bytes, options = {}) { return guard(() => attach(bytes, prepare(options))); }

function limit(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw invalid('The decoded metadata limit is a positive safe integer.');
  return value;
}

function metadataValue(type, data) {
  if (type !== EXIF) return new Uint8Array(data);
  if (data.length < 4) throw invalid('The Exif box is missing its TIFF offset.');
  const at = 4 + new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
  if (at > data.length || !tiff(data.subarray(at))) throw invalid('The Exif TIFF offset or header is invalid.');
  return new Uint8Array(data.subarray(at));
}

export function readMetadata(bytes) {
  return guard(() => {
    const source = sourceBoxes(bytes), result = {exif: [], xmp: [], jumb: [], compressed: []};
    for (const box of source ?? []) {
      const key = keys.get(box.decoded);
      if (!key) continue;
      if (box.type === BROB) result.compressed.push({boxType: box.decoded, data: new Uint8Array(bytes.subarray(box.body + 4, box.end))});
      else result[key].push(metadataValue(box.type, bytes.subarray(box.body, box.end)));
    }
    return result;
  });
}

function nativeBrotliUnsafe(versions) {
  if (!versions?.node) return false;
  const older = (version, fixed) => {
    const parts = String(version).split('.').map(part => parseInt(part, 10) || 0);
    for (let index = 0; index < 3; index++) if (parts[index] !== fixed[index]) return parts[index] < fixed[index];
    return false;
  };
  if (versions.bun) return older(versions.bun, [1, 4, 4]);
  if (versions.deno) return false;
  const major = parseInt(versions.node, 10), fixed = {22: [22, 23, 4], 24: [24, 22, 1], 26: [26, 12, 1]}[major];
  return fixed ? older(versions.node, fixed) : major < 27;
}

async function codec(data, direction, provided, maximum) {
  let result;
  if (provided !== undefined) {
    if (typeof provided !== 'function') throw invalid('The Brotli codec is a function.');
    result = await provided(data, maximum === Number.MAX_SAFE_INTEGER ? {} : {maxOutputLength: maximum});
  } else if (direction === 'decompress' && nativeBrotliUnsafe(globalThis.process?.versions)) {
    try { result = decompressBrotli(data, {maxOutputLength: maximum}); }
    catch (error) {
      if (error?.code === 'JXL_SIZE') throw error;
      throw invalid('This runtime\'s native Brotli decoder has a remote-code-execution bug (CVE-2026-111497), so only the ' +
        'portable form is read here. Update Node to 22.23.4, 24.22.1 or 26.12.1 (Bun to 1.4.4), or pass decompress.');
    }
  } else if (globalThis.process?.versions?.node) {
    const zlib = await import('node:zlib');
    const method = direction === 'compress' ? zlib.brotliCompress : zlib.brotliDecompress;
    try {
      const settings = maximum === Number.MAX_SAFE_INTEGER ? {} : {maxOutputLength: Math.max(1, maximum)};
      result = await new Promise((resolve, reject) => method(data, settings, (error, output) => error ? reject(error) : resolve(output)));
    } catch (error) {
      if (error.code === 'ERR_BUFFER_TOO_LARGE') throw fault('JXL_SIZE', 'Decoded metadata exceeds maxDecodedBytes.');
      throw invalid('Invalid Brotli metadata: ' + error.message);
    }
  } else {
    let stream;
    try {
      const Constructor = direction === 'compress' ? globalThis.CompressionStream : globalThis.DecompressionStream;
      stream = new Constructor('brotli');
    } catch {
      return (direction === 'compress' ? compressBrotli : decompressBrotli)(data, {maxOutputLength: maximum});
    }
    const reader = new Blob([data]).stream().pipeThrough(stream).getReader(), chunks = [];
    let size = 0;
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maximum) { await reader.cancel(); throw fault('JXL_SIZE', 'Decoded metadata exceeds maxDecodedBytes.'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    result = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) { result.set(chunk, at); at += chunk.length; }
  }
  if (!(result instanceof Uint8Array)) throw invalid('A Brotli codec must return a Uint8Array.');
  if (result.length > maximum) throw fault('JXL_SIZE', 'The Brotli result exceeds its admitted byte limit.');
  return result;
}

export async function withCompressedMetadata(bytes, options = {}) {
  try {
    const plan = prepare(options), source = sourceBoxes(bytes), snapshot = new Uint8Array(bytes);
    const {compression = 'auto', compress} = options;
    if (compression !== 'auto' && compression !== 'brotli') throw invalid('Metadata compression is auto or brotli.');
    if (plan.changed.size && source?.some(box => box.decoded === RECONSTRUCTION))
      throw invalid('Metadata edits would invalidate JPEG reconstruction data; retain the original JPEG XL file.');
    for (const entry of plan.entries) {
      const compressed = await codec(entry.data, 'compress', compress, Number.MAX_SAFE_INTEGER);
      if (compression === 'auto' && compressed.length + 4 >= entry.data.length) continue;
      const payload = new Uint8Array(compressed.length + 4);
      new DataView(payload.buffer).setUint32(0, entry.type); payload.set(compressed, 4);
      entry.type = BROB; entry.data = payload;
    }
    return guard(() => attach(snapshot, plan, source));
  } catch (error) { return guard(() => { throw error; }); }
}

export const METADATA_DECODED_BYTES = 67108864;
export async function readMetadataAsync(bytes, options = {}) {
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw invalid('Metadata reader options are an object.');
    const maximum = limit(options.maxDecodedBytes ?? METADATA_DECODED_BYTES), source = sourceBoxes(bytes), {decompress} = options;
    const entries = (source ?? []).filter(box => keys.has(box.decoded)).map(box => ({
      type: box.decoded, compressed: box.type === BROB, data: new Uint8Array(bytes.subarray(box.body + (box.type === BROB ? 4 : 0), box.end))
    }));
    const result = {exif: [], xmp: [], jumb: [], compressed: []};
    let total = 0;
    for (const entry of entries) {
      const data = entry.compressed ? await codec(entry.data, 'decompress', decompress, maximum - total) : entry.data;
      total += data.length;
      if (total > maximum) throw fault('JXL_SIZE', 'Decoded metadata exceeds maxDecodedBytes.');
      result[keys.get(entry.type)].push(metadataValue(entry.type, data));
    }
    return result;
  } catch (error) { return guard(() => { throw error; }); }
}
