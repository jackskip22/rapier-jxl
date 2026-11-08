// SPDX-License-Identifier: MIT
import {admitSize, fault} from './admit.mjs';
import {inspectICC, prepareColorEncoding} from './color-info.mjs';
import {exifOrientation} from './exif-orientation.mjs';
import {sRGBWithIntent} from './v7/header-intent.mjs';

const refuse = message => { throw fault('JXL_INPUT', message); };
const PNG_ICC_BYTES = 16 * 1024 * 1024;
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const primaries = {
  srgb: [.640, .330, .300, .600, .150, .060, .3127, .3290],
  'display-p3': [.680, .320, .265, .690, .150, .060, .3127, .3290],
  rec2020: [.708, .292, .170, .797, .131, .046, .3127, .3290],
};

function colourFromChromaticities(values, tolerance, required = true) {
  for (const [name, expected] of Object.entries(primaries))
    if (expected.every((value, i) => Math.abs(value - values[i]) <= tolerance)) return name;
  if (required) refuse('Primaries must be sRGB, Display P3 or Rec. 2020, D65.');
}

export async function inflate(parts, expected) {
  if (typeof DecompressionStream !== 'function') refuse('Compressed sources need DecompressionStream.');
  const profile = expected === undefined;
  let output = new Uint8Array(profile ? 4 : expected);
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
      if (profile && output.length === 4) {
        const count = Math.min(4 - offset, bytes.length);
        output.set(bytes.subarray(0, count), offset); offset += count; bytes = bytes.subarray(count);
        if (offset < 4) continue;
        expected = view(output).getUint32(0);
        if (expected < 132) refuse('The compressed ICC profile is incomplete.');
        if (expected > PNG_ICC_BYTES) throw fault('JXL_SIZE', 'The PNG ICC profile declares more than 16 MiB.');
        const complete = new Uint8Array(expected); complete.set(output); output = complete;
      }
      if (offset + bytes.length > expected) refuse(profile ? 'The ICC profile expands beyond its declared size.' : 'Compressed source data exceeds its declared dimensions.');
      output.set(bytes, offset); offset += bytes.length;
    }
    if (offset !== expected) refuse(profile ? 'The compressed ICC profile is incomplete.' : 'Compressed source data is incomplete.');
    return output;
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error.code === 'JXL_INPUT' || error.code === 'JXL_SIZE' || error instanceof RangeError) throw error;
    refuse('The source contains an invalid deflate stream.');
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

async function pngColour(chunks, colourType) {
  const space = colourType === 0 || colourType === 4 ? 'gray' : 'rgb';
  const cicp = chunks.get('cICP');
  if (cicp) {
    const colorSpace = {1: 'srgb', 9: 'rec2020', 11: 'display-p3', 12: 'display-p3'}[cicp[0]];
    const transferFunction = {1: 'bt709', 8: 'linear', 13: 'srgb', 16: 'pq', 17: 'dci', 18: 'hlg'}[cicp[1]];
    if (!colorSpace || !transferFunction || cicp[2] !== 0 || cicp[3] !== 1)
      refuse('PNG cICP needs supported RGB primaries and transfer, full range, identity matrix.');
    if (cicp[0] === 11 || transferFunction === 'bt709' || transferFunction === 'dci')
      return explicitPNGColor(space, {whitePoint: cicp[0] === 11 ? 'dci' : 'd65', ...(space === 'rgb' ? {primaries: colorSpace} : {}), transferFunction});
    return {colorSpace, transferFunction};
  }
  const packedProfile = chunks.get('iCCP');
  if (packedProfile) {
    const end = packedProfile.indexOf(0), name = packedProfile.subarray(0, end);
    if (end < 1 || end > 79 || end + 2 >= packedProfile.length || packedProfile[end + 1] !== 0 ||
        name[0] === 32 || name[name.length - 1] === 32 || name.some((value, i) => value < 32 || value > 126 && value < 161 || value === 32 && name[i - 1] === 32))
      refuse('PNG iCCP needs a valid name, method 0 and a complete deflate stream.');
    const icc = await inflate([packedProfile.subarray(end + 2)]), channels = inspectICC(icc, undefined, space);
    if (channels !== (space === 'gray' ? 1 : 3)) refuse('PNG channels and ICC space differ.');
    return {icc};
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

const pngPasses = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
  [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
export function unfilterRow(filter, raw, at, row, previous, n, bpp) {
  if (filter === 0) { row.set(raw.subarray(at, at + n)); return; }
  const first = Math.min(bpp, n);
  if (filter === 1) {
    for (let i = 0; i < first; i++) row[i] = raw[at + i];
    for (let i = first; i < n; i++) row[i] = raw[at + i] + row[i - bpp];
  } else if (filter === 2) {
    for (let i = 0; i < n; i++) row[i] = raw[at + i] + previous[i];
  } else if (filter === 3) {
    for (let i = 0; i < first; i++) row[i] = raw[at + i] + (previous[i] >> 1);
    for (let i = first; i < n; i++) row[i] = raw[at + i] + ((row[i - bpp] + previous[i]) >> 1);
  } else {
    for (let i = 0; i < first; i++) row[i] = raw[at + i] + previous[i];
    for (let i = first; i < n; i++) {
      const a = row[i - bpp], b = previous[i], c = previous[i - bpp], p = a + b - c;
      const pa = p > a ? p - a : a - p, pb = p > b ? p - b : b - p, pc = p > c ? p - c : c - p;
      row[i] = raw[at + i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
    }
  }
}

const PNG_CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4};
export function pngWalk(w, bytes, at, size) {
  const data = view(bytes), stop = at + bytes.length;
  let {offset = 8, crcAt = 0, crc = 0, length = 0, seen = 0, ended = false, chunks = new Map(), parts = [], exifAt} = w ?? {};
  const walk = (next, least = 0, done = false) => ({offset, crcAt, crc, length, seen, ended, chunks, parts, exifAt, next, least, done});
  for (;;) {
    if (ended || offset + 12 > size) return walk(offset, 0, true);
    if (offset + 8 > stop) return walk(offset);
    const going = offset < at;
    if (!going) length = data.getUint32(offset - at);
    const end = offset + 12 + length;
    if (length > 0x7fffffff || end > size) refuse('The PNG contains a truncated chunk.');
    const nameBytes = going ? [] : bytes.subarray(offset + 4 - at, offset + 8 - at), name = going ? 'IDAT' : String.fromCharCode(...nameBytes);
    if (!/^[A-Za-z]{4}$/.test(name) || nameBytes[2] & 32) refuse('The PNG contains an invalid chunk name.');
    if (crcAt < offset + 4) { crcAt = offset + 4; crc = 0; }
    const checked = Math.min(end - 4, stop);
    crc = crc32(bytes.subarray(crcAt - at, checked - at), crc); crcAt = checked;
    if (end > stop) {
      if (name === 'IDAT') return walk(checked);
      crcAt = 0;
      return walk(offset, end - offset);
    }
    if (crc !== data.getUint32(end - 4 - at)) refuse('A PNG chunk checksum does not match.');
    const part = name === 'IDAT' ? null : bytes.slice(offset + 8 - at, end - 4 - at);
    if (offset === 8 && name !== 'IHDR') refuse('PNG must begin with IHDR.');
    if (seen === 1 && name !== 'IDAT') seen = 2;
    const header = name === 'IHDR' ? part : chunks.get('IHDR'), depth = header?.[8], colourType = header?.[9];
    if (name === 'IHDR') {
      if (chunks.has(name) || length !== 13) refuse('PNG requires one complete IHDR.');
      admitSize(view(part).getUint32(0), view(part).getUint32(4));
      const channels = PNG_CHANNELS[colourType];
      const depthOK = depth === 16 ? channels && colourType !== 3 : depth === 8 ? channels : (depth === 1 || depth === 2 || depth === 4) && (colourType === 0 || colourType === 3);
      if (!depthOK || part[10] || part[11] || part[12] > 1)
        refuse('PNG must be 8- or 16-bit gray, RGB or RGBA, palette up to 8 bits, or gray at 1, 2 or 4 bits.');
      chunks.set(name, part);
    } else if (name === 'IDAT') {
      if (seen === 2) refuse('PNG image data chunks must be consecutive.');
      seen = 1; parts.push([offset + 8, length]);
    } else if (name === 'IEND') {
      if (length || !seen || end !== size) refuse('PNG requires a final empty IEND after image data.');
      ended = true;
    } else if (name === 'eXIf') {
      if (!seen && !chunks.has(name)) { chunks.set(name, part); exifAt = offset + 8; }
    } else if (name === 'acTL' || name === 'fcTL' || name === 'fdAT') {
      refuse('Animated PNG is not a single source picture.');
    } else if (['cICP', 'sRGB', 'iCCP', 'gAMA', 'cHRM', 'tRNS', 'sBIT', 'PLTE', 'mDCV', 'cLLI'].includes(name)) {
      if (seen || chunks.has(name)) refuse('PNG color and transparency chunks occur once, before image data.');
      const sizes = {cICP: 4, sRGB: 1, gAMA: 4, cHRM: 32, mDCV: 24, cLLI: 8};
      if (sizes[name] !== undefined && length !== sizes[name]) refuse('A PNG color chunk has an invalid size.');
      if (name === 'sRGB' && part[0] > 3) refuse('PNG sRGB rendering intent is invalid.');
      if (name === 'sBIT' && (length !== {0: 1, 2: 3, 3: 3, 4: 2, 6: 4}[colourType] || part.some(value => value < 1 || value > (colourType === 3 ? 8 : depth))))
        refuse('PNG significant sample depths are invalid.');
      if (name === 'tRNS' && !((colourType === 0 && length === 2) || (colourType === 2 && length === 6) ||
          (colourType === 3 && length >= 1 && length <= (chunks.get('PLTE')?.length ?? 0) / 3)))
        refuse('PNG transparency does not match the channels or palette.');
      if (name === 'PLTE' && (colourType === 0 || colourType === 4 || !length || length > 768 || length % 3 || (colourType === 3 && length / 3 > 1 << depth)))
        refuse('The PNG palette is invalid for its channel layout.');
      chunks.set(name, part);
    } else if (!(nameBytes[0] & 32)) refuse('The PNG has an unsupported critical chunk.');
    offset = end;
  }
}

export function pngOrientationLocation({chunks, exifAt}) {
  const header = view(chunks.get('IHDR')), exif = chunks.get('eXIf');
  let orientationAt, orientationBig;
  const orientation = exif ? exifOrientation(exif,0,exif.length,(at,big) => { orientationAt = exifAt + at; orientationBig = big; }) : null;
  return {width:header.getUint32(0),height:header.getUint32(4),orientation:orientation ?? 1,orientationAt,orientationBig,
    ...(orientationAt !== undefined && {exifAt,exifLength:exif.length})};
}

export async function pngLayout({chunks, parts, ended}, named) {
  if (!ended) refuse('PNG image data or its end marker is missing.');
  const header = chunks.get('IHDR'), width = view(header).getUint32(0), height = view(header).getUint32(4), depth = header[8],
    colourType = header[9], channels = PNG_CHANNELS[colourType], interlace = header[12];
  const palette = chunks.get('PLTE');
  if (colourType === 3 && !palette) refuse('A palette PNG requires a PLTE chunk.');
  const colour = await pngColour(chunks, colourType);
  if (named && colour.colorEncoding && sRGBWithIntent(colour)[0] === colour) throw fault('JXL_UNSUPPORTED', 'fit and variants need a named color space; this PNG sets gamma, primaries or intent. Use encode.');
  const passes = interlace ? pngPasses : [[0, 0, 1, 1]], bitsPerPixel = channels * depth;
  let expected = 0;
  for (const [x, y, dx, dy] of passes) {
    const w = Math.max(0, Math.ceil((width - x) / dx)), h = Math.max(0, Math.ceil((height - y) / dy));
    if (w && h) expected += h * (1 + Math.ceil(w * bitsPerPixel / 8));
  }
  const key = chunks.get('tRNS'), transparent = key && colourType !== 3 ? Array.from({length: key.length / 2}, (_, i) => view(key).getUint16(i * 2)) : null;
  const exif = chunks.get('eXIf'), orientation = exif ? exifOrientation(exif, 0, exif.length) : null;
  return {width, height, depth, colourType, channels, interlace, expected, palette: palette ?? null, paletteAlpha: colourType === 3 ? key ?? null : null,
    transparent, colour, orientation, parts};
}

export async function pngStructure(bytes, named) {
  const layout = await pngLayout(pngWalk(null, bytes, 0, bytes.length), named);
  return {...layout, packed: layout.parts.map(([at, length]) => bytes.subarray(at, at + length))};
}
export function pngRows({width, depth, colourType, channels, palette, paletteAlpha, transparent}, result, row0 = 0) {
  const wide = depth === 16, full = wide ? 65535 : 255, entries = palette ? palette.length / 3 : 0, scale = wide || depth === 8 ? 1 : 255 / ((1 << depth) - 1);
  const plainDepth = !wide && depth === 8 && colourType !== 3 && !transparent;
  return (row, w, startX, startY, dx, dy, y) => {
    if (plainDepth && dx === 1) {
      const at = (startY + y * dy - row0) * width * 4;
      if (channels === 4) result.set(row.subarray(0, w * 4), at);
      else if (channels === 3) for (let x = 0, i = 0, o = at; x < w; x++, i += 3, o += 4) { result[o] = row[i]; result[o + 1] = row[i + 1]; result[o + 2] = row[i + 2]; result[o + 3] = 255; }
      else if (channels === 2) for (let x = 0, i = 0, o = at; x < w; x++, i += 2, o += 4) { const v = row[i]; result[o] = v; result[o + 1] = v; result[o + 2] = v; result[o + 3] = row[i + 1]; }
      else for (let x = 0, o = at; x < w; x++, o += 4) { const v = row[x]; result[o] = v; result[o + 1] = v; result[o + 2] = v; result[o + 3] = 255; }
      return;
    }
    const samples = view(row);
    const sample = wide ? n => samples.getUint16(n * 2) : depth === 8 ? n => row[n] : n => (row[(n * depth) >> 3] >> (8 - depth - ((n * depth) & 7))) & ((1 << depth) - 1);
    for (let x = 0; x < w; x++) {
      const dst = ((startY + y * dy - row0) * width + startX + x * dx) * 4;
      if (colourType === 3) {
        const index = sample(x);
        if (index >= entries) refuse('A PNG palette index is past its palette.');
        result[dst] = palette[index * 3]; result[dst + 1] = palette[index * 3 + 1]; result[dst + 2] = palette[index * 3 + 2];
        result[dst + 3] = index < (paletteAlpha?.length ?? 0) ? paletteAlpha[index] : 255;
        continue;
      }
      const r = sample(x * channels), g = channels < 3 ? r : sample(x * channels + 1), b = channels < 3 ? r : sample(x * channels + 2);
      result[dst] = r * scale; result[dst + 1] = g * scale; result[dst + 2] = b * scale;
      result[dst + 3] = colourType === 4 || colourType === 6 ? sample(x * channels + channels - 1) :
        transparent && r === transparent[0] && (colourType === 0 || g === transparent[1] && b === transparent[2]) ? 0 : full;
    }
  };
}
export function pngPassRows({width, height, depth, channels, interlace}) {
  const bits = channels * depth;
  return (interlace ? pngPasses : [[0, 0, 1, 1]]).map(([x, y, dx, dy]) => {
    const w = Math.max(0, Math.ceil((width - x) / dx)), h = Math.max(0, Math.ceil((height - y) / dy));
    return [x, y, dx, dy, w, h, Math.ceil(w * bits / 8)];
  }).filter(p => p[4] && p[5]);
}

async function png(bytes, named) {
  const structure = await pngStructure(bytes, named), {width, height, depth, channels, expected, packed, colour, orientation} = structure;
  const raw = await inflate(packed, expected), wide = depth === 16, bytesPerPixel = Math.max(1, (channels * depth) >> 3);
  const result = wide ? new Uint16Array(width * height * 4) : new Uint8Array(width * height * 4), write = pngRows(structure, result);
  let cursor = 0;
  for (const [startX, startY, dx, dy, w, h, rowBytes] of pngPassRows(structure)) {
    let previous = new Uint8Array(rowBytes), row = new Uint8Array(rowBytes);
    for (let y = 0; y < h; y++) {
      const filter = raw[cursor++];
      if (filter > 4) refuse('The PNG contains an unknown row filter.');
      unfilterRow(filter, raw, cursor, row, previous, rowBytes, bytesPerPixel);
      cursor += rowBytes;
      write(row, w, startX, startY, dx, dy, y);
      [previous, row] = [row, previous];
    }
  }
  return {data: result, width, height, bitDepth: wide ? 16 : 8, sampleFormat: 'uint', ...colour, alphaPremultiplied: false, ...(orientation > 1 && {orientation})};
}

function unrollRle(packed, expected) {
  const raw = new Uint8Array(expected);
  let src = 0, dst = 0;
  while (src < packed.length) {
    const count = (packed[src++] << 24) >> 24;
    if (count < 0) {
      const length = -count;
      if (src + length > packed.length || dst + length > expected) refuse('The OpenEXR RLE block exceeds its bounds.');
      raw.set(packed.subarray(src, src + length), dst); src += length; dst += length;
    } else {
      if (src === packed.length || dst + count + 1 > expected) refuse('The OpenEXR RLE block exceeds its bounds.');
      raw.fill(packed[src++], dst, dst + count + 1); dst += count + 1;
    }
  }
  if (dst !== expected) refuse('The OpenEXR RLE block is incomplete.');
  return raw;
}

function undoPrediction(predicted) {
  for (let i = 1; i < predicted.length; i++) predicted[i] = predicted[i - 1] + predicted[i] - 128;
  const raw = new Uint8Array(predicted.length), split = (raw.length + 1) >> 1;
  for (let i = 0; i < raw.length; i++) raw[i] = predicted[(i >> 1) + (i & 1 ? split : 0)];
  return raw;
}

async function exr(bytes) {
  const data = view(bytes), attributes = new Map(), version = data.getUint32(4, true);
  if ((version & 255) !== 2 || version & ~0x402) refuse('OpenEXR must be a single flat scanline image (version 2).');
  let cursor = 8;
  const nameLimit = version & 0x400 ? 255 : 31;
  function string(end = bytes.length) {
    const start = cursor;
    while (cursor < end && bytes[cursor] && cursor - start <= nameLimit) cursor++;
    if (cursor >= end || cursor - start > nameLimit) refuse('An OpenEXR header name is incomplete or too long.');
    const value = String.fromCharCode(...bytes.subarray(start, cursor)); cursor++; return value;
  }
  for (;;) {
    const name = string();
    if (!name) break;
    const type = string();
    if (!type || cursor + 4 > bytes.length || attributes.has(name)) refuse('OpenEXR header has a bad or duplicate attribute.');
    const length = data.getInt32(cursor, true); cursor += 4;
    if (length < 0 || cursor + length > bytes.length) refuse('An OpenEXR attribute is truncated.');
    attributes.set(name, {type, start: cursor, length}); cursor += length;
  }
  function attribute(name, type, length, required = true) {
    const value = attributes.get(name);
    if (!value) { if (required) refuse('OpenEXR is missing its ' + name + ' attribute.'); return null; }
    if (value.type !== type || length !== undefined && value.length !== length) refuse('The OpenEXR ' + name + ' attribute has an invalid type or size.');
    return value;
  }
  const channelList = attribute('channels', 'chlist'), tableStart = cursor;
  cursor = channelList.start;
  const channelEnd = cursor + channelList.length, channels = [];
  for (;;) {
    const name = string(channelEnd);
    if (!name) break;
    if (cursor + 16 > channelEnd) refuse('The OpenEXR channel list is truncated.');
    const kind = data.getInt32(cursor, true), x = data.getInt32(cursor + 8, true), y = data.getInt32(cursor + 12, true);
    if (!['R', 'G', 'B', 'A', 'Y'].includes(name) || channels.some(channel => channel.name === name) || kind !== 1 && kind !== 2 || x !== 1 || y !== 1)
      refuse('OpenEXR needs unsubsampled RGB or Y, optional A, uniform HALF or FLOAT.');
    channels.push({name, kind}); cursor += 16;
  }
  if (cursor !== channelEnd || !channels.length) refuse('The OpenEXR channel list is invalid.');
  const gray = channels.some(channel => channel.name === 'Y'), hasAlpha = channels.some(channel => channel.name === 'A');
  const names = channels.map(channel => channel.name).sort().join('');
  if (names !== (gray ? hasAlpha ? 'AY' : 'Y' : hasAlpha ? 'ABGR' : 'BGR') || channels.some(channel => channel.kind !== channels[0].kind))
    refuse('OpenEXR needs unsubsampled RGB or Y, optional A, uniform HALF or FLOAT.');
  channels.sort((a, b) => a.name < b.name ? -1 : 1);
  const half = channels[0].kind === 1, sampleBytes = half ? 2 : 4;
  const bounds = attribute('dataWindow', 'box2i', 16).start, display = attribute('displayWindow', 'box2i', 16).start;
  const minX = data.getInt32(bounds, true), minY = data.getInt32(bounds + 4, true);
  const maxX = data.getInt32(bounds + 8, true), maxY = data.getInt32(bounds + 12, true);
  const width = maxX - minX + 1, height = maxY - minY + 1; admitSize(width, height);
  for (let i = 0; i < 16; i += 4) if (data.getInt32(bounds + i, true) !== data.getInt32(display + i, true))
    refuse('OpenEXR data and display windows differ; crop first.');
  const compression = bytes[attribute('compression', 'compression', 1).start];
  if (compression > 3) refuse('OpenEXR compression must be NONE, RLE, ZIPS or ZIP.');
  if (bytes[attribute('lineOrder', 'lineOrder', 1).start] > 1) refuse('OpenEXR line order must be increasing or decreasing.');
  if (data.getFloat32(attribute('pixelAspectRatio', 'float', 4).start, true) !== 1)
    refuse('OpenEXR pixels must be square; resample first.');
  attribute('screenWindowCenter', 'v2f', 8); attribute('screenWindowWidth', 'float', 4);
  for (const name of ['colorInteropID', 'acesImageContainerFlag', 'adoptedNeutral', 'renderingTransform', 'lookModTransform'])
    if (attributes.has(name)) refuse('The OpenEXR ' + name + ' color declaration requires a colour-managed source reader.');
  let colorSpace = 'srgb';
  const chroma = attribute('chromaticities', 'chromaticities', 32, false);
  if (chroma) colorSpace = colourFromChromaticities(Array.from({length: 8}, (_, i) => data.getFloat32(chroma.start + i * 4, true)), .0000001);
  const white = attribute('whiteLuminance', 'float', 4, false), luminance = {};
  if (white) {
    const value = data.getFloat32(white.start, true);
    if (!Number.isFinite(value) || value < 1 / 16777216 || value >= 65520) refuse('OpenEXR white luminance exceeds the intensity target.');
    luminance.intensityTarget = value;
  }
  const rowsPerBlock = compression === 3 ? 16 : 1, blocks = Math.ceil(height / rowsPerBlock), tableEnd = tableStart + blocks * 8;
  if (tableEnd > bytes.length) refuse('The OpenEXR scanline offset table is truncated.');
  const locations = [];
  for (let i = 0; i < blocks; i++) {
    const offset = Number(data.getBigUint64(tableStart + i * 8, true));
    if (!Number.isSafeInteger(offset) || offset < tableEnd || offset + 8 > bytes.length) refuse('An OpenEXR scanline offset is outside the file.');
    const y = data.getInt32(offset, true), length = data.getInt32(offset + 4, true), row = y - minY;
    if (length < 0 || offset + 8 + length > bytes.length || row !== i * rowsPerBlock)
      refuse('OpenEXR scanline block does not match its offset.');
    locations.push({offset, length, row});
  }
  const physical = [...locations].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < physical.length; i++) if (physical[i].offset < physical[i - 1].offset + 8 + physical[i - 1].length)
    refuse('OpenEXR scanline blocks overlap.');
  const result = half ? new Uint16Array(width * height * 4) : new Uint32Array(width * height * 4);
  const alpha = half ? 0x3c00 : 0x3f800000;
  if (!hasAlpha) for (let i = 3; i < result.length; i += 4) result[i] = alpha;
  for (const {offset, length, row} of locations) {
    const rows = Math.min(rowsPerBlock, height - row), expected = rows * width * channels.length * sampleBytes;
    const packed = bytes.subarray(offset + 8, offset + 8 + length);
    let raw = packed;
    if (length !== expected) {
      if (!compression || length > expected) refuse('The OpenEXR scanline block has an invalid size.');
      raw = undoPrediction(compression === 1 ? unrollRle(packed, expected) : await inflate([packed], expected));
    }
    const samples = view(raw);
    for (let y = 0; y < rows; y++) for (let c = 0; c < channels.length; c++) {
      const name = channels[c].name, component = {R: 0, G: 1, B: 2, A: 3, Y: 0}[name];
      for (let x = 0; x < width; x++) {
        const src = ((y * channels.length + c) * width + x) * sampleBytes, dst = ((row + y) * width + x) * 4;
        const word = half ? samples.getUint16(src, true) : samples.getUint32(src, true);
        result[dst + component] = word;
        if (name === 'Y') result[dst + 1] = result[dst + 2] = word;
      }
    }
  }
  return {data: half ? result : new Float32Array(result.buffer), width, height, bitDepth: half ? 16 : 32,
    sampleFormat: half ? 'float16' : 'float32', colorSpace, transferFunction: 'linear', alphaPremultiplied: hasAlpha, ...luminance};
}

async function read(input, reader) {
  try {
    if (!(input instanceof Uint8Array) && !(input instanceof ArrayBuffer) || input.byteLength === 0) refuse('Source bytes are a nonempty Uint8Array or ArrayBuffer.');
    const bytes = input instanceof ArrayBuffer ? new Uint8Array(input.slice(0)) : new Uint8Array(input);
    return await reader(bytes);
  } catch (error) {
    if (error instanceof RangeError && !error.code) throw fault('JXL_MEMORY', 'Not enough memory to read this source picture.');
    throw error;
  }
}
const isPNG = bytes => bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value);
export function readSource(input) {
  return read(input, bytes => {
    if (isPNG(bytes)) return png(bytes);
    if (bytes.length >= 8 && view(bytes).getUint32(0, true) === 20000630) return exr(bytes);
    refuse('Source must be PNG or flat scanline OpenEXR.');
  });
}
export function readPNG16(input, {named = false} = {}) {
  return read(input, bytes => { if (isPNG(bytes)) return png(bytes, named); refuse('Source bytes must contain a PNG.'); });
}
