// SPDX-License-Identifier: MIT
import {outOfMemory} from './fault.mjs';
import {admitSize, fault} from './admit.mjs';
import {prepareColorEncoding} from './color-info.mjs';

const refuse = message => { throw fault('JXL_INPUT', message); };
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const primaries = {
  srgb: [.640, .330, .300, .600, .150, .060, .3127, .3290],
  'display-p3': [.680, .320, .265, .690, .150, .060, .3127, .3290],
  rec2020: [.708, .292, .170, .797, .131, .046, .3127, .3290],
};

function colourFromChromaticities(values, tolerance, required = true) {
  for (const [name, expected] of Object.entries(primaries))
    if (expected.every((value, i) => Math.abs(value - values[i]) <= tolerance)) return name;
  if (required) refuse('primaries: srgb|display-p3|rec2020, D65');
}

const DEFLATE_RATIO = 1032, FIRST_OUTPUT = 64 * 1024;
export async function inflate(parts, expected, maxBytes) {
  let present = false;
  try { present = typeof DecompressionStream === 'function'; } catch {}
  if (!present) throw fault('JXL_PLATFORM', 'DecompressionStream: required; use pixels {data,width,height} or Node.js runtime');
  const ceiling = parts.reduce((n, part) => n + part.length, 0) * DEFLATE_RATIO;
  const profile = expected === undefined;
  const incomplete = profile ? 'ICC profile: incomplete' : 'source data: incomplete';
  if (!profile && expected > ceiling) refuse(incomplete);
  let output = new Uint8Array(profile ? 4 : Math.min(expected, FIRST_OUTPUT));
  const stream = new ReadableStream({start(controller) {
    for (const part of parts) controller.enqueue(part);
    controller.close();
  }}).pipeThrough(new DecompressionStream('deflate'));
  const reader = stream.getReader();
  let offset = 0;
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      let bytes = value;
      if (profile && expected === undefined) {
        const count = Math.min(4 - offset, bytes.length);
        output.set(bytes.subarray(0, count), offset); offset += count; bytes = bytes.subarray(count);
        if (offset < 4) continue;
        expected = view(output).getUint32(0);
        if (expected < 132) refuse(incomplete);
        if (maxBytes !== undefined && expected > maxBytes) throw fault('JXL_LIMIT', 'maxMetadataBytes: increase or smaller input');
        if (expected > ceiling) refuse(incomplete);
      }
      if (offset + bytes.length > expected) refuse(profile ? 'ICC profile: exceeds declared size' : 'source data: exceeds declared dimensions');
      if (offset + bytes.length > output.length) {
        const grown = new Uint8Array(Math.min(expected, Math.max(offset + bytes.length, output.length * 4)));
        grown.set(output.subarray(0, offset)); output = grown;
      }
      output.set(bytes, offset); offset += bytes.length;
    }
    if (expected === undefined || offset !== expected) refuse(incomplete);
    return output;
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (String(error?.code).startsWith('JXL_') || outOfMemory(error)) throw error;
    refuse('deflate stream: malformed');
  } finally { reader.releaseLock(); }
}

const crcTable = Uint32Array.from({length: 256}, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
const crcTables = (() => {
  const t = new Uint32Array(8 * 256);
  t.set(crcTable);
  for (let i = 0; i < 256; i++) for (let k = 1; k < 8; k++) { const v = t[(k - 1) * 256 + i]; t[k * 256 + i] = (v >>> 8) ^ crcTable[v & 255]; }
  return t;
})();
export function crc32(bytes, crc = 0) {
  let i = 0;
  crc = ~crc;
  const t = crcTables, end = bytes.length - 7;
  for (; i < end; i += 8) {
    const a = (crc ^ (bytes[i] | bytes[i + 1] << 8 | bytes[i + 2] << 16 | bytes[i + 3] << 24)) >>> 0;
    crc = t[1792 + (a & 255)] ^ t[1536 + (a >>> 8 & 255)] ^ t[1280 + (a >>> 16 & 255)] ^ t[1024 + (a >>> 24)] ^
      t[768 + bytes[i + 4]] ^ t[512 + bytes[i + 5]] ^ t[256 + bytes[i + 6]] ^ t[bytes[i + 7]];
  }
  for (; i < bytes.length; i++) crc = (crc >>> 8) ^ t[(crc ^ bytes[i]) & 255];
  return ~crc >>> 0;
}

function explicitPNGColor(space, fields) {
  const colorEncoding = {space, ...fields};
  prepareColorEncoding(colorEncoding);
  return {colorEncoding};
}

export function pngColourStatement(chunks, colourType) {
  const space = colourType === 0 || colourType === 4 ? 'gray' : 'rgb';
  const cicp = chunks.get('cICP');
  if (cicp) {
    const colorSpace = {1: 'srgb', 9: 'rec2020', 11: 'display-p3', 12: 'display-p3'}[cicp[0]];
    const transferFunction = {1: 'bt709', 8: 'linear', 13: 'srgb', 16: 'pq', 17: 'dci', 18: 'hlg'}[cicp[1]];
    if (!colorSpace || !transferFunction || cicp[2] !== 0 || cicp[3] !== 1)
      refuse('cICP: RGB primaries/transfer, full range, identity');
    if (cicp[0] === 11 || transferFunction === 'bt709' || transferFunction === 'dci')
      return explicitPNGColor(space, {whitePoint: cicp[0] === 11 ? 'dci' : 'd65', ...(space === 'rgb' ? {primaries: colorSpace} : {}), transferFunction});
    return {colorSpace, transferFunction};
  }
  const packedProfile = chunks.get('iCCP');
  if (packedProfile) {
    const end = packedProfile.indexOf(0), name = packedProfile.subarray(0, end);
    if (end < 1 || end > 79 || end + 2 >= packedProfile.length || packedProfile[end + 1] !== 0 ||
        name[0] === 32 || name[name.length - 1] === 32 || name.some((value, i) => value < 32 || value > 126 && value < 161 || value === 32 && name[i - 1] === 32))
      refuse('iCCP: name, method 0, complete deflate');
    return {packed: packedProfile.subarray(end + 2)};
  }
  const srgb = chunks.get('sRGB');
  if (srgb) {
    if (srgb[0] !== 1) return explicitPNGColor(space, {transferFunction: 'srgb', renderingIntent: ['perceptual', 'relative', 'saturation', 'absolute'][srgb[0]]});
    return {colorSpace: 'srgb', transferFunction: 'srgb'};
  }
  const gamma = chunks.get('gAMA'), chroma = chunks.get('cHRM');
  const exponent = gamma ? view(gamma).getUint32(0) / 100000 : undefined;
  let colorSpace = 'srgb', whitePoint = 'd65', customPrimaries;
  if (chroma) {
    const data = view(chroma), values = Array.from({length: 8}, (_, i) => data.getUint32(i * 4) / 100000);
    colorSpace = colourFromChromaticities([...values.slice(2), ...values.slice(0, 2)], .0000051, false);
    if (!colorSpace) { whitePoint = values.slice(0, 2); customPrimaries = [values.slice(2, 4), values.slice(4, 6), values.slice(6, 8)]; }
  }
  if (!colorSpace || exponent !== undefined && exponent !== 1)
    return explicitPNGColor(space, {whitePoint, ...(space === 'rgb' ? {primaries: colorSpace ?? customPrimaries} : {}),
      ...(exponent === undefined ? {transferFunction: 'srgb'} : {gamma: exponent})});
  return {colorSpace, transferFunction: gamma ? 'linear' : 'srgb'};
}
export const PNG_CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4};
export function pngWalk(w, bytes, at, size, maxPixels) {
  const data = view(bytes), stop = at + bytes.length;
  let {offset = 8, crcAt = 0, crc = 0, length = 0, seen = 0, ended = false, chunks = new Map(), parts = [], exifAt} = w ?? {};
  const walk = (next, least = 0, done = false) => ({offset, crcAt, crc, length, seen, ended, chunks, parts, exifAt, next, least, done});
  for (;;) {
    if (ended || offset + 12 > size) return walk(offset, 0, true);
    if (offset + 8 > stop) return walk(offset);
    const going = offset < at;
    if (!going) length = data.getUint32(offset - at);
    const end = offset + 12 + length;
    if (length > 0x7fffffff || end > size) refuse('PNG chunk: incomplete');
    const nameBytes = going ? [] : bytes.subarray(offset + 4 - at, offset + 8 - at), name = going ? 'IDAT' : String.fromCharCode(...nameBytes);
    if (!/^[A-Za-z]{4}$/.test(name) || nameBytes[2] & 32) refuse('PNG chunk name: four letters');
    if (crcAt < offset + 4) { crcAt = offset + 4; crc = 0; }
    const checked = Math.min(end - 4, stop);
    crc = crc32(bytes.subarray(crcAt - at, checked - at), crc); crcAt = checked;
    if (end > stop) {
      if (name === 'IDAT') return walk(checked);
      crcAt = 0;
      return walk(offset, end - offset);
    }
    if (crc !== data.getUint32(end - 4 - at)) refuse('PNG chunk: checksum mismatch');
    const part = name === 'IDAT' ? null : bytes.slice(offset + 8 - at, end - 4 - at);
    if (offset === 8 && name !== 'IHDR') refuse('PNG: IHDR first');
    if (seen === 1 && name !== 'IDAT') seen = 2;
    const header = name === 'IHDR' ? part : chunks.get('IHDR'), depth = header?.[8], colourType = header?.[9];
    if (name === 'IHDR') {
      if (chunks.has(name) || length !== 13) refuse('IHDR: exactly one complete');
      admitSize(view(part).getUint32(0), view(part).getUint32(4), maxPixels);
      const channels = PNG_CHANNELS[colourType];
      const depthOK = depth === 16 ? channels && colourType !== 3 : depth === 8 ? channels : (depth === 1 || depth === 2 || depth === 4) && (colourType === 0 || colourType === 3);
      if (!depthOK || part[10] || part[11] || part[12] > 1)
        refuse('depth: gray 1|2|4|8|16, RGB(A) 8|16, palette <=8');
      chunks.set(name, part);
    } else if (name === 'IDAT') {
      if (seen === 2) refuse('IDAT: consecutive');
      seen = 1; parts.push([offset + 8, length]);
    } else if (name === 'IEND') {
      if (length || !seen || end !== size) refuse('IEND: final empty after IDAT');
      ended = true;
    } else if (name === 'eXIf') {
      if (!seen && !chunks.has(name)) { chunks.set(name, part); exifAt = offset + 8; }
    } else if (name === 'acTL' || name === 'fcTL' || name === 'fdAT') {
      throw fault('JXL_UNSUPPORTED', 'animated PNG: use jpegxl/animation');
    } else if (['cICP', 'sRGB', 'iCCP', 'gAMA', 'cHRM', 'tRNS', 'sBIT', 'PLTE', 'mDCV', 'cLLI'].includes(name)) {
      if (seen || chunks.has(name)) refuse('PNG color/transparency: once before IDAT');
      const sizes = {cICP: 4, sRGB: 1, gAMA: 4, cHRM: 32, mDCV: 24, cLLI: 8};
      if (sizes[name] !== undefined && length !== sizes[name]) refuse('PNG color chunk: invalid length');
      if (name === 'sRGB' && part[0] > 3) refuse('sRGB intent: 0-3');
      if (name === 'sBIT' && (length !== {0: 1, 2: 3, 3: 3, 4: 2, 6: 4}[colourType] || part.some(value => value < 1 || value > (colourType === 3 ? 8 : depth))))
        refuse('sBIT: invalid channel depths');
      if (name === 'tRNS' && !((colourType === 0 && length === 2) || (colourType === 2 && length === 6) ||
          (colourType === 3 && length >= 1 && length <= (chunks.get('PLTE')?.length ?? 0) / 3)))
        refuse('tRNS: channel/palette mismatch');
      if (name === 'PLTE' && (colourType === 0 || colourType === 4 || !length || length > 768 || length % 3 || (colourType === 3 && length / 3 > 1 << depth)))
        refuse('PLTE: invalid for channel layout');
      chunks.set(name, part);
    } else if (!(nameBytes[0] & 32)) refuse('PNG critical chunk: unknown');
    offset = end;
  }
}

