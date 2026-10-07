// SPDX-License-Identifier: MIT
// Deterministic source samples and standalone PNG/OpenEXR recipes; no encoder code is shared.
import {deflateSync} from 'node:zlib';

export function integerFixture(bitDepth, width = 17, height = 9) {
  const maximum = 2 ** bitDepth - 1, data = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    data[i] = (x * 257 + y * 103 + 1) & maximum;
    data[i + 1] = (maximum - x * 67 - y * 211) & maximum;
    data[i + 2] = (x * x * 13 + y * 509 + 3) & maximum;
    data[i + 3] = [0, maximum, 1, maximum - 1, maximum >> 1][(x + y) % 5];
  }
  data.set([0, 1, maximum, 0], 0);
  if (data.length >= 8) data.set([maximum, maximum - 1, 2, maximum], 4);
  return {width, height, data, options: {bitDepth}};
}

export function floatFixture({half = false, special = false, width = 17, height = 9} = {}) {
  const words = half ? [0, 0x8000, 1, 0x8001, 0x3ff, 0x400, 0x3c00, 0xbc00, 0x7bff, 0xfbff,
    0x3801, 0xb555, 0x3555, 0x401, 0x3bff, 0x3c01] :
    [0, 0x80000000, 1, 0x80000001, 0x007fffff, 0x00800000, 0x3f800000, 0xbf800000,
      0x477fe000, 0xc77fe000, 0x3f000001, 0xbeaaaaab, 0x3eaaaaab, 0x00800001, 0x3f7fffff, 0x3f800001];
  if (special) words.push(...(half ? [0x7c00, 0xfc00, 0x7e01, 0xfe55] : [0x7f800000, 0xff800000, 0x7fc00001, 0xffc12345]));
  const raw = half ? new Uint16Array(width * height * 4) : new Uint32Array(width * height * 4);
  const alpha = half ? [0, 0x8000, 1, 0x3c00, 0x3800] : [0, 0x80000000, 1, 0x3f800000, 0x3f000000];
  for (let i = 0; i < raw.length; i++) raw[i] = i % 4 === 3 ? alpha[(i >> 2) % alpha.length] : words[(i + (i >> 2) * 3) % words.length];
  const data = half ? raw : new Float32Array(raw.buffer);
  return {width, height, data, options: half ? {sampleFormat: 'float16'} : {}};
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function pngChunk(type, data) {
  const name = Buffer.from(type), chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0); name.copy(chunk, 4); data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

export function png16Fixture({width, height, data}, {primaries = 1, transfer = 13, colorType = 6, filter = 0, interlace = false, metadata} = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 16; header[9] = colorType; header[12] = Number(interlace);
  const components = {0: [0], 2: [0, 1, 2], 4: [0, 3], 6: [0, 1, 2, 3]}[colorType], bpp = components.length * 2;
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const rows = [];
  for (const [x0, y0, dx, dy] of passes) {
    if (x0 >= width || y0 >= height) continue;
    let previous = Buffer.alloc(Math.ceil((width - x0) / dx) * bpp);
    for (let y = y0; y < height; y += dy) {
      const raw = Buffer.alloc(previous.length), packed = Buffer.alloc(raw.length + 1);
      packed[0] = filter;
      for (let x = x0, p = 0; x < width; x += dx) for (const c of components) { raw.writeUInt16BE(data[(y * width + x) * 4 + c], p); p += 2; }
      for (let i = 0; i < raw.length; i++) {
        const a = i >= bpp ? raw[i - bpp] : 0, b = previous[i], c = i >= bpp ? previous[i - bpp] : 0;
        const distances = [Math.abs(b - c), Math.abs(a - c), Math.abs(a + b - 2 * c)];
        const prediction = filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : filter === 4 ?
          [a, b, c][distances.indexOf(Math.min(...distances))] : 0;
        packed[i + 1] = (raw[i] - prediction) & 255;
      }
      previous = raw; rows.push(packed);
    }
  }
  const chunks = [pngChunk('IHDR', header), ...(metadata ?? [['cICP', Buffer.from([primaries, transfer, 0, 1])]]).map(([name, value]) => pngChunk(name, value))];
  chunks.push(pngChunk('IDAT', deflateSync(Buffer.concat(rows))), pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]);
}

const zstring = value => Buffer.from(value + '\0');
const int32 = value => { const bytes = Buffer.alloc(4); bytes.writeInt32LE(value); return bytes; };
const float32 = value => { const bytes = Buffer.alloc(4); bytes.writeFloatLE(value); return bytes; };
const attribute = (name, type, data) => Buffer.concat([zstring(name), zstring(type), int32(data.length), data]);

function exrPack(raw, compression) {
  if (compression === 'none') return raw;
  const predicted = Buffer.alloc(raw.length), split = (raw.length + 1) >> 1;
  for (let i = 0; i < raw.length; i++) predicted[(i >> 1) + (i & 1 ? split : 0)] = raw[i];
  for (let i = predicted.length - 1; i > 0; i--) predicted[i] = (predicted[i] - predicted[i - 1] + 128) & 255;
  if (compression !== 'rle') {
    const packed = deflateSync(predicted); return packed.length < raw.length ? packed : raw;
  }
  const packed = [];
  for (let i = 0; i < predicted.length;) {
    let count = 1;
    while (count < 128 && i + count < predicted.length && predicted[i + count] === predicted[i]) count++;
    if (count >= 3) { packed.push(count - 1, predicted[i]); i += count; continue; }
    const start = i++;
    while (i - start < 127 && i < predicted.length && !(i + 2 < predicted.length && predicted[i] === predicted[i + 1] && predicted[i] === predicted[i + 2])) i++;
    packed.push((-(i - start)) & 255, ...predicted.subarray(start, i));
  }
  return packed.length < raw.length ? Buffer.from(packed) : raw;
}

export function exrFixture({width, height, data, options = {}}, {rec2020 = false, compression = 'none', whiteLuminance} = {}) {
  const half = options.sampleFormat === 'float16', bytesPerSample = half ? 2 : 4;
  const channel = name => Buffer.concat([zstring(name), int32(half ? 1 : 2), Buffer.alloc(4), int32(1), int32(1)]);
  const bounds = Buffer.concat([int32(0), int32(0), int32(width - 1), int32(height - 1)]);
  const chromaticities = rec2020 ? [.708, .292, .170, .797, .131, .046, .3127, .3290] : [.640, .330, .300, .600, .150, .060, .3127, .3290];
  const header = Buffer.concat([
    int32(20000630), int32(2),
    attribute('channels', 'chlist', Buffer.concat(['A', 'B', 'G', 'R'].map(channel).concat(Buffer.alloc(1)))),
    attribute('compression', 'compression', Buffer.from([{none: 0, rle: 1, zips: 2, zip: 3}[compression]])), attribute('dataWindow', 'box2i', bounds),
    attribute('displayWindow', 'box2i', bounds), attribute('lineOrder', 'lineOrder', Buffer.alloc(1)),
    attribute('pixelAspectRatio', 'float', float32(1)), attribute('screenWindowCenter', 'v2f', Buffer.alloc(8)),
    attribute('screenWindowWidth', 'float', float32(1)),
    attribute('chromaticities', 'chromaticities', Buffer.concat(chromaticities.map(float32))),
    ...(whiteLuminance === undefined ? [] : [attribute('whiteLuminance', 'float', float32(whiteLuminance))]), Buffer.alloc(1),
  ]);
  const rowsPerBlock = compression === 'zip' ? 16 : 1, blocks = Math.ceil(height / rowsPerBlock);
  const offsets = Buffer.alloc(blocks * 8), scanlineBytes = width * 4 * bytesPerSample, rows = [];
  const words = half ? data : new Uint32Array(data.buffer, data.byteOffset, data.length);
  let offset = header.length + offsets.length;
  for (let y = 0, block = 0; y < height; y += rowsPerBlock, block++) {
    offsets.writeBigUInt64LE(BigInt(offset), block * 8);
    const count = Math.min(rowsPerBlock, height - y), raw = Buffer.alloc(scanlineBytes * count);
    for (let line = 0; line < count; line++) for (let c = 0; c < 4; c++) for (let x = 0; x < width; x++) {
      const src = (((y + line) * width + x) * 4 + 3 - c), dst = (line * width * 4 + c * width + x) * bytesPerSample;
      if (half) raw.writeUInt16LE(words[src], dst); else raw.writeUInt32LE(words[src], dst);
    }
    const packed = exrPack(raw, compression), row = Buffer.concat([int32(y), int32(packed.length), packed]);
    rows.push(row);
    offset += row.length;
  }
  return Buffer.concat([header, offsets, ...rows]);
}
