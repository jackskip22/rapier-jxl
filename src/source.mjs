// SPDX-License-Identifier: MIT
// File bytes to source samples. Compression, channel layout and colour declarations end at this boundary;
// the encoder receives the same RGBA words as a caller supplying typed arrays directly.
import {admitSize, fault} from './admit.mjs';

const refuse = message => { throw fault('JXL_INPUT', message); };
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const primaries = {
  srgb: [.640, .330, .300, .600, .150, .060, .3127, .3290],
  'display-p3': [.680, .320, .265, .690, .150, .060, .3127, .3290],
  rec2020: [.708, .292, .170, .797, .131, .046, .3127, .3290],
};

function colourFromChromaticities(values, tolerance) {
  for (const [name, expected] of Object.entries(primaries))
    if (expected.every((value, i) => Math.abs(value - values[i]) <= tolerance)) return name;
  refuse('The source primaries must be sRGB, Display P3 or Rec. 2020 with a D65 white point.');
}

// The expected extent comes from admitted dimensions, never from the compressed stream. Reading through
// a bounded destination refuses both incomplete data and a stream that expands beyond its declared picture.
async function inflate(parts, expected) {
  if (typeof DecompressionStream !== 'function') refuse('Reading compressed sources requires DecompressionStream (Node 22 or a supporting browser).');
  const output = new Uint8Array(expected);
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
      if (offset + value.length > expected) refuse('Compressed source data exceeds its declared dimensions.');
      output.set(value, offset); offset += value.length;
    }
    if (offset !== expected) refuse('Compressed source data is incomplete.');
    return output;
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error.code === 'JXL_INPUT' || error instanceof RangeError) throw error;
    refuse('The source contains an invalid deflate stream.');
  } finally { reader.releaseLock(); }
}

const crcTable = Uint32Array.from({length: 256}, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

function pngColour(chunks) {
  const cicp = chunks.get('cICP');
  if (cicp) {
    const colorSpace = {1: 'srgb', 9: 'rec2020', 12: 'display-p3'}[cicp[0]];
    const transferFunction = {8: 'linear', 13: 'srgb', 16: 'pq', 18: 'hlg'}[cicp[1]];
    if (!colorSpace || !transferFunction || cicp[2] !== 0 || cicp[3] !== 1)
      refuse('PNG cICP must declare supported D65 RGB primaries, sRGB/linear/PQ/HLG transfer and full-range samples.');
    return {colorSpace, transferFunction};
  }
  // PNG Third Edition gives cICP precedence over ICC, followed by sRGB and then cHRM/gAMA.
  if (chunks.has('iCCP')) refuse('Embedded PNG ICC profiles require a colour-managed source reader.');
  if (chunks.has('sRGB')) return {colorSpace: 'srgb', transferFunction: 'srgb'};
  const gamma = chunks.get('gAMA'), chroma = chunks.get('cHRM');
  if (gamma && view(gamma).getUint32(0) !== 100000)
    refuse('PNG gamma curves other than linear require a colour-managed source reader or an explicit sRGB/cICP declaration.');
  let colorSpace = 'srgb';
  if (chroma) {
    const data = view(chroma), values = Array.from({length: 8}, (_, i) => data.getUint32(i * 4) / 100000);
    colorSpace = colourFromChromaticities([...values.slice(2), ...values.slice(0, 2)], .0000051);
  }
  // An untagged PNG is admitted using the encoder's documented sRGB assumption.
  return {colorSpace, transferFunction: gamma ? 'linear' : 'srgb'};
}

const pngPasses = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
  [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

async function png(bytes) {
  const data = view(bytes), chunks = new Map(), packed = [];
  let offset = 8, seenData = false, endedData = false, ended = false, width, height, channels, colourType, interlace;
  while (offset + 12 <= bytes.length) {
    const length = data.getUint32(offset), end = offset + 12 + length;
    if (length > 0x7fffffff || end > bytes.length) refuse('The PNG contains a truncated chunk.');
    const nameBytes = bytes.subarray(offset + 4, offset + 8), name = String.fromCharCode(...nameBytes);
    if (!/^[A-Za-z]{4}$/.test(name) || nameBytes[2] & 32) refuse('The PNG contains an invalid chunk name.');
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== data.getUint32(end - 4)) refuse('A PNG chunk checksum does not match.');
    const part = bytes.subarray(offset + 8, end - 4);
    if (offset === 8 && name !== 'IHDR') refuse('PNG must begin with IHDR.');
    if (seenData && name !== 'IDAT') endedData = true;
    if (name === 'IHDR') {
      if (chunks.has(name) || length !== 13) refuse('PNG requires one complete IHDR.');
      const header = view(part); width = header.getUint32(0); height = header.getUint32(4); admitSize(width, height);
      colourType = part[9]; channels = {0: 1, 2: 3, 4: 2, 6: 4}[colourType]; interlace = part[12];
      if (part[8] !== 16 || !channels || part[10] || part[11] || interlace > 1)
        refuse('This source reader accepts 16-bit grayscale, RGB or RGBA PNG, with standard compression and filtering.');
      chunks.set(name, part);
    } else if (name === 'IDAT') {
      if (endedData) refuse('PNG image data chunks must be consecutive.');
      seenData = true; packed.push(part);
    } else if (name === 'IEND') {
      if (length || !seenData || end !== bytes.length) refuse('PNG requires a final empty IEND after image data.');
      ended = true; break;
    } else if (name === 'acTL' || name === 'fcTL' || name === 'fdAT') {
      refuse('Animated PNG is not a single source picture.');
    } else if (['cICP', 'sRGB', 'iCCP', 'gAMA', 'cHRM', 'tRNS', 'sBIT', 'PLTE', 'mDCV', 'cLLI'].includes(name)) {
      if (seenData || chunks.has(name)) refuse('PNG colour and transparency chunks must occur once before image data.');
      const sizes = {cICP: 4, sRGB: 1, gAMA: 4, cHRM: 32, mDCV: 24, cLLI: 8};
      if (sizes[name] !== undefined && length !== sizes[name]) refuse('A PNG colour chunk has an invalid size.');
      if (name === 'sRGB' && part[0] > 3) refuse('PNG sRGB rendering intent is invalid.');
      if (name === 'sBIT' && (length !== channels || part.some(value => value < 1 || value > 16))) refuse('PNG significant sample depths are invalid.');
      if (name === 'tRNS' && !((colourType === 0 && length === 2) || (colourType === 2 && length === 6)))
        refuse('PNG transparency must match its source channel layout.');
      if (name === 'PLTE' && (colourType === 0 || colourType === 4 || !length || length > 768 || length % 3))
        refuse('The PNG palette is invalid for its channel layout.');
      chunks.set(name, part);
    } else if (!(nameBytes[0] & 32)) refuse('The PNG has an unsupported critical chunk.');
    offset = end;
  }
  if (!ended) refuse('PNG image data or its end marker is missing.');
  const colour = pngColour(chunks), passes = interlace ? pngPasses : [[0, 0, 1, 1]], bytesPerPixel = channels * 2;
  let expected = 0;
  for (const [x, y, dx, dy] of passes) {
    const w = Math.max(0, Math.ceil((width - x) / dx)), h = Math.max(0, Math.ceil((height - y) / dy));
    if (w && h) expected += h * (1 + w * bytesPerPixel);
  }
  const raw = await inflate(packed, expected), result = new Uint16Array(width * height * 4);
  const key = chunks.get('tRNS'), transparent = key ? Array.from({length: key.length / 2}, (_, i) => view(key).getUint16(i * 2)) : null;
  let cursor = 0;
  for (const [startX, startY, dx, dy] of passes) {
    const w = Math.max(0, Math.ceil((width - startX) / dx)), h = Math.max(0, Math.ceil((height - startY) / dy));
    if (!w || !h) continue;
    const rowBytes = w * bytesPerPixel;
    let previous = new Uint8Array(rowBytes), row = new Uint8Array(rowBytes);
    for (let y = 0; y < h; y++) {
      const filter = raw[cursor++];
      if (filter > 4) refuse('The PNG contains an unknown row filter.');
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0, b = previous[i], c = i >= bytesPerPixel ? previous[i - bytesPerPixel] : 0;
        row[i] = raw[cursor++] + (filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth(a, b, c) : 0);
      }
      const samples = view(row);
      for (let x = 0; x < w; x++) {
        const src = x * bytesPerPixel, dst = ((startY + y * dy) * width + startX + x * dx) * 4;
        const r = samples.getUint16(src), g = channels < 3 ? r : samples.getUint16(src + 2), b = channels < 3 ? r : samples.getUint16(src + 4);
        result[dst] = r; result[dst + 1] = g; result[dst + 2] = b;
        result[dst + 3] = colourType === 4 || colourType === 6 ? samples.getUint16(src + bytesPerPixel - 2) :
          transparent && r === transparent[0] && (colourType === 0 || g === transparent[1] && b === transparent[2]) ? 0 : 65535;
      }
      [previous, row] = [row, previous];
    }
  }
  return {data: result, width, height, bitDepth: 16, sampleFormat: 'uint', ...colour, alphaPremultiplied: false};
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
    if (!type || cursor + 4 > bytes.length || attributes.has(name)) refuse('The OpenEXR header contains an invalid or duplicate attribute.');
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
      refuse('OpenEXR requires unsubsampled RGB or Y, optional A, and uniform HALF or FLOAT channels.');
    channels.push({name, kind}); cursor += 16;
  }
  if (cursor !== channelEnd || !channels.length) refuse('The OpenEXR channel list is invalid.');
  const gray = channels.some(channel => channel.name === 'Y'), hasAlpha = channels.some(channel => channel.name === 'A');
  const names = channels.map(channel => channel.name).sort().join('');
  if (names !== (gray ? hasAlpha ? 'AY' : 'Y' : hasAlpha ? 'ABGR' : 'BGR') || channels.some(channel => channel.kind !== channels[0].kind))
    refuse('OpenEXR requires unsubsampled RGB or Y, optional A, and uniform HALF or FLOAT channels.');
  channels.sort((a, b) => a.name < b.name ? -1 : 1);
  const half = channels[0].kind === 1, sampleBytes = half ? 2 : 4;
  const bounds = attribute('dataWindow', 'box2i', 16).start, display = attribute('displayWindow', 'box2i', 16).start;
  const minX = data.getInt32(bounds, true), minY = data.getInt32(bounds + 4, true);
  const maxX = data.getInt32(bounds + 8, true), maxY = data.getInt32(bounds + 12, true);
  const width = maxX - minX + 1, height = maxY - minY + 1; admitSize(width, height);
  // A crop or overscan has a different display extent. Refuse it instead of silently changing placement.
  for (let i = 0; i < 16; i += 4) if (data.getInt32(bounds + i, true) !== data.getInt32(display + i, true))
    refuse('OpenEXR data and display windows must coincide; crop or place the source explicitly.');
  const compression = bytes[attribute('compression', 'compression', 1).start];
  if (compression > 3) refuse('OpenEXR compression must be NONE, RLE, ZIPS or ZIP.');
  if (bytes[attribute('lineOrder', 'lineOrder', 1).start] > 1) refuse('OpenEXR scanlines must have increasing or decreasing line order.');
  if (data.getFloat32(attribute('pixelAspectRatio', 'float', 4).start, true) !== 1)
    refuse('OpenEXR pixels must be square; resample the source explicitly.');
  attribute('screenWindowCenter', 'v2f', 8); attribute('screenWindowWidth', 'float', 4);
  for (const name of ['colorInteropID', 'acesImageContainerFlag', 'adoptedNeutral', 'renderingTransform', 'lookModTransform'])
    if (attributes.has(name)) refuse('The OpenEXR ' + name + ' colour declaration requires a colour-managed source reader.');
  let colorSpace = 'srgb';
  const chroma = attribute('chromaticities', 'chromaticities', 32, false);
  if (chroma) colorSpace = colourFromChromaticities(Array.from({length: 8}, (_, i) => data.getFloat32(chroma.start + i * 4, true)), .0000001);
  const white = attribute('whiteLuminance', 'float', 4, false), luminance = {};
  if (white) {
    const value = data.getFloat32(white.start, true);
    if (!Number.isFinite(value) || value < 1 / 16777216 || value >= 65520) refuse('OpenEXR white luminance must fit the positive JPEG XL intensity target.');
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
      refuse('The OpenEXR scanline block does not match its offset table.');
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

/** Read a 16-bit PNG or flat scanline OpenEXR into exact source samples and encode options. */
export async function readSource(input) {
  try {
    if (!(input instanceof Uint8Array) && !(input instanceof ArrayBuffer) || input.byteLength === 0) refuse('Source bytes are a nonempty Uint8Array or ArrayBuffer containing PNG16 or OpenEXR.');
    // Own the input before the first asynchronous decompression; caller mutation cannot split the file's identity.
    const bytes = input instanceof ArrayBuffer ? new Uint8Array(input.slice(0)) : new Uint8Array(input);
    if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)) return await png(bytes);
    if (bytes.length >= 8 && view(bytes).getUint32(0, true) === 20000630) return await exr(bytes);
    refuse('Source bytes must contain a 16-bit PNG or a flat scanline OpenEXR image.');
  } catch (error) {
    if (error instanceof RangeError && !error.code) throw fault('JXL_MEMORY', 'Not enough memory to read this source picture.');
    throw error;
  }
}
