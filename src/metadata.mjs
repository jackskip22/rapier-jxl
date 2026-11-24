// SPDX-License-Identifier: MIT
import {fault, guard, admitOutputSize} from './admit.mjs';
import {SIGNATURE, FTYP, LEVEL, CODESTREAM, EXIF, XML, JUMBF, BROB, RECONSTRUCTION, boxes, fileHeader, boxHeader} from './container.mjs';
import {compressBrotli, decompressBrotli} from './brotli.mjs';
import {callers, isCaller, typedName, plainView} from './v7/primitives.mjs';
import {codestreamLevel} from './framing.mjs';

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

function sourceBoxes(bytes, options = {}) {
  if (options === null || typeof options !== 'object') throw invalid('metadata options: object');
  if (!(bytes instanceof Uint8Array) || bytes.length < 2) throw invalid('input: Uint8Array');
  const maxBoxes = options.maxBoxes ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxBoxes) || maxBoxes < 1) throw invalid('maxBoxes: integer 1-' + Number.MAX_SAFE_INTEGER);
  const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw invalid('maxBytes: integer 1-' + Number.MAX_SAFE_INTEGER);
  if (bytes.length > maxBytes) throw fault('JXL_SIZE', 'container: maxBytes exceeded');
  admitOutputSize(bytes.length);
  if (bytes[0] === 255 && bytes[1] === 10) return null;
  if (!SIGNATURE.every((byte, i) => bytes[i] === byte)) throw invalid('signature');
  const source = [];
  for (const box of boxes(bytes, maxBoxes)) source.push(box);
  return source;
}

function prepare(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw invalid('metadata options: {exif,xmp,jumb}');
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
        throw invalid('Exif: TIFF bytes II|MM, no APP1');
      if (key === 'xmp' ? typeof item !== 'string' && !(item instanceof Uint8Array) : !(item instanceof Uint8Array))
        throw invalid(key === 'xmp' ? 'XMP: string|Uint8Array' : 'JUMBF: Uint8Array|array');
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

function attach(bytes, plan, source, maxBoxes = Number.MAX_SAFE_INTEGER) {
  const {changed, entries} = plan, edited = changed.size > 0;
  const added = entries.reduce((sum, entry) => sum + entry.data.length + 8, 0);
  const head = source === null && added ? fileHeader(codestreamLevel(bytes)) : null;
  let prefix = 0, length = bytes.length + added;
  if (source === null) { if (added) length += head.length + 8; }
  else for (const box of source) {
    if (box.type === FTYP || box.type === LEVEL && box.at === prefix) prefix = box.end;
    if (edited && box.decoded === RECONSTRUCTION) throw invalid('metadata edits: keep original for JPEG reconstruction');
    if (changed.has(box.decoded)) length -= box.end - box.at;
    else if (box.type === EXIF) metadataValue(EXIF, bytes.subarray(box.body, box.end));
  }
  const count = source === null ? (added ? (head.length > 32 ? 2 : 1) + entries.length + 1 : 0)
    : source.reduce((n, box) => n + Number(!changed.has(box.decoded)), 0) + entries.length;
  if (count > maxBoxes) throw invalid('box count: maxBoxes exceeded');
  admitOutputSize(length);
  if (!edited || source === null && !added) return new Uint8Array(bytes);
  const output = new Uint8Array(length);
  let at = source === null ? head.length : prefix;
  output.set(source === null ? head : bytes.subarray(0, prefix));
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

export function withMetadata(bytes, options = {}) { return guard(() => { const source = sourceBoxes(bytes, options), plan = prepare(options); return attach(bytes, plan, source, options.maxBoxes); }); }

function limit(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw invalid('maxDecodedBytes: positive safe integer');
  return value;
}

function metadataValue(type, data) {
  if (type !== EXIF) return new Uint8Array(data);
  if (data.length < 4) throw invalid('Exif: TIFF offset missing');
  const at = 4 + new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
  if (at > data.length || !tiff(data.subarray(at))) throw invalid('Exif: invalid TIFF offset or header');
  return new Uint8Array(data.subarray(at));
}

export function readMetadata(bytes, options = {}) {
  return guard(() => {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw invalid('metadata reader options: object');
    const maximum = limit(options.maxDecodedBytes ?? METADATA_DECODED_BYTES);
    const source = sourceBoxes(bytes, options), result = {exif: [], xmp: [], jumb: [], compressed: []};
    let plain = 0;
    for (const box of source ?? []) if (box.type !== BROB && keys.has(box.decoded)) {
      const length = box.end - box.body;
      if (length > maximum - plain) throw fault('JXL_SIZE', 'decoded metadata: maxDecodedBytes exceeded');
      plain += length;
    }
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

function nodeZlib() {
  if (!globalThis.process?.versions?.node) return null;
  try { return globalThis.process.getBuiltinModule?.('node:zlib') ?? null; } catch { return null; }
}

async function codec(data, direction, provided, maximum) {
  let result;
  if (provided !== undefined) {
    if (typeof provided !== 'function') throw invalid('Brotli codec: function');
    try { result = await provided(data, maximum === Number.MAX_SAFE_INTEGER ? {} : {maxOutputLength: maximum}); }
    catch (error) { throw callers(error); }
  } else if (direction === 'compress') {
    result = compressBrotli(data, {maxOutputLength: maximum});
  } else if (direction === 'decompress' && nativeBrotliUnsafe(globalThis.process?.versions)) {
    try { result = decompressBrotli(data, {maxOutputLength: maximum}); }
    catch (error) {
      if (error?.code === 'JXL_SIZE' || error?.code === 'JXL_MEMORY') throw error;
      throw invalid('unsafe runtime Brotli: update Node 22.23.4, 24.22.1 or 26.12.1, or Bun 1.4.4, or pass decompress');
    }
  } else if (nodeZlib()) {
    const zlib = nodeZlib();
    const method = zlib.brotliDecompress;
    const os = globalThis.process?.getBuiltinModule?.('node:os');
    const constrained = globalThis.process?.constrainedMemory?.();
    const hostMem = constrained > 0 && constrained < Number.MAX_SAFE_INTEGER ? constrained : os ? os.totalmem() : Infinity;
    const memCap = 268435456;
    const effective = Math.min(maximum, memCap);
    try {
      const settings = {maxOutputLength: Math.max(1, effective)};
      result = await new Promise((resolve, reject) => method(data, settings, (error, output) =>
        error ? reject(error) : resolve(new Uint8Array(output.buffer, output.byteOffset, output.byteLength))));
    } catch (error) {
      if (error.code === 'ERR_BUFFER_TOO_LARGE')
        throw maximum <= memCap
          ? fault('JXL_SIZE', 'decoded metadata: maxDecodedBytes exceeded')
          : fault('JXL_MEMORY', 'Brotli: output exceeds available memory; pass maxMetadataBytes or smaller metadata');
      throw invalid('Brotli: ' + error.message);
    }
  } else {
    let stream;
    try {
      stream = new globalThis.DecompressionStream('brotli');
    } catch {
      return decompressBrotli(data, {maxOutputLength: maximum});
    }
    let gigabytes;
    try { gigabytes = globalThis.navigator?.deviceMemory; } catch {}
    const hostMem = gigabytes > 0 ? gigabytes * 2 ** 29 : Infinity;
    const memCap = 268435456;
    const reader = new Blob([data]).stream().pipeThrough(stream).getReader(), chunks = [];
    let size = 0;
    try {
      while (true) {
        let step;
        try { step = await reader.read(); } catch (error) { throw invalid('Brotli: ' + (error?.message || error?.code || 'unreadable stream')); }
        const {done, value} = step;
        if (done) break;
        size += value.length;
        if (size > maximum) {
          try { await reader.cancel(); } catch {}
          throw fault('JXL_SIZE', 'decoded metadata: maxDecodedBytes exceeded');
        }
        if (size > memCap) {
          try { await reader.cancel(); } catch {}
          throw fault('JXL_MEMORY', 'Brotli: output exceeds available memory; pass maxMetadataBytes or smaller metadata');
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    result = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) { result.set(chunk, at); at += chunk.length; }
  }
  if (!(result instanceof Uint8Array) && typedName.call(result) !== 'Uint8Array') throw invalid('Brotli result: Uint8Array');
  result = plainView(result);
  if (result.length > maximum) throw fault('JXL_SIZE', 'Brotli result: byte limit exceeded');
  return result;
}

export async function withCompressedMetadata(bytes, options = {}) {
  try {
    const source = sourceBoxes(bytes, options), plan = prepare(options), snapshot = new Uint8Array(bytes);
    const {compression = 'auto', compress} = options;
    if (compression !== 'auto' && compression !== 'brotli') throw invalid('metadata compression: auto|brotli');
    if (compress !== undefined && typeof compress !== 'function') throw invalid('Brotli codec: function');
    if (plan.changed.size && source?.some(box => box.decoded === RECONSTRUCTION))
      throw invalid('metadata edits: keep original for JPEG reconstruction');
    for (const entry of plan.entries) {
      const compressed = await codec(entry.data, 'compress', compress, Number.MAX_SAFE_INTEGER);
      if (compression === 'auto' && compressed.length + 4 >= entry.data.length) continue;
      const payload = new Uint8Array(compressed.length + 4);
      new DataView(payload.buffer).setUint32(0, entry.type); payload.set(compressed, 4);
      entry.type = BROB; entry.data = payload;
    }
    return guard(() => attach(snapshot, plan, source, options.maxBoxes));
  } catch (error) { if (isCaller(error)) throw error; return guard(() => { throw error; }); }
}

export const METADATA_DECODED_BYTES = Number.MAX_SAFE_INTEGER;
export async function readMetadataAsync(bytes, options = {}) {
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw invalid('metadata reader options: object');
    const maximum = limit(options.maxDecodedBytes ?? METADATA_DECODED_BYTES), source = sourceBoxes(bytes, options), {decompress} = options;
    const plain = (source ?? []).filter(box => keys.has(box.decoded) && box.type !== BROB).reduce((sum, box) => sum + box.end - box.body, 0);
    if (plain > maximum) throw fault('JXL_SIZE', 'decoded metadata: maxDecodedBytes exceeded');
    const entries = (source ?? []).filter(box => keys.has(box.decoded)).map(box => ({
      type: box.decoded, compressed: box.type === BROB, data: new Uint8Array(bytes.subarray(box.body + (box.type === BROB ? 4 : 0), box.end))
    }));
    const result = {exif: [], xmp: [], jumb: [], compressed: []};
    let total = 0;
    for (const entry of entries) {
      const data = entry.compressed ? await codec(entry.data, 'decompress', decompress, maximum - total) : entry.data;
      total += data.length;
      if (total > maximum) throw fault('JXL_SIZE', 'decoded metadata: maxDecodedBytes exceeded');
      result[keys.get(entry.type)].push(!entry.compressed && entry.type !== EXIF ? data : metadataValue(entry.type, data));
    }
    return result;
  } catch (error) { if (isCaller(error)) throw error; return guard(() => { throw error; }); }
}
