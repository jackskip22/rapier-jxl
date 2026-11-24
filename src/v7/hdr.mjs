// SPDX-License-Identifier: MIT
import './engines.mjs';
import {snapshotOptions, blobBytes, declared, fail as refuse, isBlob} from './primitives.mjs';
import {copyBytes, arrayBufferBytes} from './bytes.mjs';
import {outOfMemory} from '../fault.mjs';

const EXPANSION = [1, 64, 1032, 1032, 454, 1032, 3, 11, 66048, 66048];
const LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const fail = (code, message) => refuse(/^HDR_(DIMENSIONS|LIMIT)$/.test(code) ? 'JXL_DIMENSIONS' : 'JXL_INPUT',
  message);

const EXR_MAGIC = 20000630;
const VERSION_TILED = 0x0200, VERSION_LONG_NAMES = 0x0400, VERSION_NON_IMAGE = 0x0800, VERSION_MULTIPART = 0x1000;
const COMPRESSION_NAMES = ['NONE', 'RLE', 'ZIPS', 'ZIP', 'PIZ', 'PXR24', 'B44', 'B44A', 'DWAA', 'DWAB', 'HTJ2K256', 'HTJ2K32', 'LJ2K', 'ZSTD'];
const SCANLINES_PER_BLOCK = [1, 1, 1, 16, 32, 16, 32, 32, 32, 256];

async function inflateExact(packed, expectedBytes) {
  let present = false;
  try { present = typeof DecompressionStream === 'function'; } catch {}
  if (!present) throw refuse('JXL_PLATFORM', 'compressed EXR: DecompressionStream required');
  if (packed.byteLength * 1032 < expectedBytes) throw fail('HDR_MALFORMED', 'EXR zlib: short');
  const out = new Uint8Array(expectedBytes);
  const reader = new ReadableStream({start(controller) { controller.enqueue(packed); controller.close(); }})
    .pipeThrough(new DecompressionStream('deflate')).getReader();
  let offset = 0;
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      if (offset + value.byteLength > expectedBytes) throw fail('HDR_MALFORMED', 'EXR zlib: too large');
      out.set(value, offset); offset += value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw /^JXL_/.test(error.code) ? error : fail('HDR_MALFORMED', 'EXR zlib: corrupt');
  }
  if (offset !== expectedBytes) throw fail('HDR_MALFORMED', 'EXR zlib: short');
  return out;
}

function unrollRle(packed, expected) {
  if (packed.length * 64 < expected) throw fail('HDR_MALFORMED', 'EXR RLE: size mismatch');
  const raw = new Uint8Array(expected);
  let src = 0, dst = 0;
  while (src < packed.length) {
    const count = (packed[src++] << 24) >> 24;
    if (count < 0) {
      const length = -count;
      if (src + length > packed.length || dst + length > expected) {
        throw fail('HDR_MALFORMED', 'EXR RLE literal: bounds');
      }
      raw.set(packed.subarray(src, src + length), dst);
      src += length;
      dst += length;
    } else {
      const run = count + 1;
      if (src >= packed.length || dst + run > expected) {
        throw fail('HDR_MALFORMED', 'EXR RLE repeat: bounds');
      }
      raw.fill(packed[src++], dst, dst + run);
      dst += run;
    }
  }
  if (dst !== expected) throw fail('HDR_MALFORMED', 'EXR RLE: size mismatch');
  return raw;
}

function undoBytePrediction(predicted) {
  for (let i = 1; i < predicted.length; i++) {
    predicted[i] = (predicted[i - 1] + predicted[i] - 128) & 0xff;
  }
  const raw = new Uint8Array(predicted.length);
  const split = Math.ceil(raw.length / 2);
  for (let i = 0; i < raw.length; i++) {
    raw[i] = predicted[Math.floor(i / 2) + ((i & 1) ? split : 0)];
  }
  return raw;
}

function halfBitsToFloat32Bits(h) {
  const sign = (h & 0x8000) << 16;
  const exp = (h >>> 10) & 0x1f;
  const mant = h & 0x03ff;
  if (exp === 0) {
    if (mant === 0) return sign;
    let m = mant, e = 127 - 14;
    while ((m & 0x0400) === 0) { m <<= 1; e--; }
    return (sign | (e << 23) | ((m & 0x03ff) << 13)) >>> 0;
  }
  if (exp === 31) {
    return (sign | 0x7f800000 | (mant ? (mant << 13) | 0x00400000 : 0)) >>> 0;
  }
  return (sign | ((exp + 112) << 23) | (mant << 13)) >>> 0;
}
const ORIENTATION_RE = /^([+-][XY])\s+(\d+)\s+([+-][XY])\s+(\d+)\s*$/;

function parseHeader(bytes) {
  const limit = bytes.length;
  let pos = 0;
  let format = null, exposure = 1.0, exposureSeen = false, primaries = null, pixAspect = 1.0;
  let colorCorr = [1.0, 1.0, 1.0];

  const nextLine = () => {
    const start = pos;
    while (pos < limit && bytes[pos] !== 0x0a) pos++;
    if (pos >= limit) throw fail('HDR_MALFORMED', 'Radiance header: incomplete');
    let end = pos;
    if (end > start && bytes[end - 1] === 0x0d) end--;
    pos++;
    return ascii(bytes, start, end);
  };

  const first = nextLine();
  if (!first.startsWith('#?RADIANCE') && !first.startsWith('#?RGBE') && !first.startsWith('FORMAT=')) {
    throw fail('HDR_FORMAT', 'not Radiance RGBE: missing #?RADIANCE or #?RGBE signature');
  }
  const parseDirective = line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if (eq < 0) return;
    const key = trimmed.slice(0, eq).trim().toUpperCase();
    const val = trimmed.slice(eq + 1).trim();
    if (key === 'FORMAT') {
      format = val.toLowerCase();
    } else if (key === 'EXPOSURE') {
      const num = Number(val);
      if (!Number.isFinite(num) || num <= 0) throw fail('HDR_MALFORMED', 'EXPOSURE: positive finite');
      exposure *= num;
      if (!Number.isFinite(exposure) || exposure <= 0) throw fail('HDR_MALFORMED', 'EXPOSURE: positive finite');
      exposureSeen = true;
    } else if (key === 'PIXASPECT') {
      const num = Number(val);
      if (Number.isFinite(num) && num > 0) pixAspect *= num;
    } else if (key === 'COLORCORR') {
      const parts = val.split(/\s+/).filter(Boolean).map(Number);
      if (parts.length !== 3 || parts.some(v => !Number.isFinite(v) || v <= 0)) {
        throw fail('HDR_MALFORMED', 'COLORCORR: 3 positive numbers');
      }
      colorCorr = [colorCorr[0] * parts[0], colorCorr[1] * parts[1], colorCorr[2] * parts[2]];
      if (colorCorr.some(v => !Number.isFinite(v) || v <= 0)) throw fail('HDR_MALFORMED', 'COLORCORR: 3 positive numbers');
    } else if (key === 'PRIMARIES') {
      const parts = val.split(/\s+/).filter(Boolean).map(Number);
      if (parts.length !== 8 || parts.some(v => !Number.isFinite(v))) {
        throw fail('HDR_MALFORMED', 'PRIMARIES: 8 finite numbers');
      }
      primaries = parts;
    }
  };

  if (first.startsWith('FORMAT=')) parseDirective(first);
  for (;;) {
    const line = nextLine();
    if (line === '') break;
    parseDirective(line);
  }
  if (format !== '32-bit_rle_rgbe' && format !== '32-bit_rle_xyze') {
    throw fail('HDR_UNSUPPORTED', `Radiance FORMAT: 32-bit_rle_rgbe, got ${format ?? 'none'}`);
  }

  const resLine = nextLine();
  const match = ORIENTATION_RE.exec(resLine);
  if (!match) throw fail('HDR_MALFORMED', `Radiance resolution: ${resLine}`);
  const [, axis1, len1Str, axis2, len2Str] = match;
  if (axis1[1] === axis2[1]) throw fail('HDR_MALFORMED', 'Radiance axes: X and Y');
  const scanCount = Number(len1Str), scanWidth = Number(len2Str);
  if (!Number.isSafeInteger(scanCount) || !Number.isSafeInteger(scanWidth) || scanCount < 1 || scanWidth < 1) {
    throw fail('HDR_DIMENSIONS', 'Radiance dimensions: positive integers');
  }
  return {
    dataStart: pos,
    format,
    exposure: exposureSeen ? exposure : 1.0,
    exposureSeen,
    colorCorr,
    pixAspect,
    primaries,
    axis1,
    axis2,
    scanCount,
    scanWidth,
  };
}

function decodeScanlines(bytes, cursor, scanWidth, scanCount) {
  const rowRgbe = new Uint8Array(scanWidth * 4);
  const all = new Uint8Array(scanCount * scanWidth * 4);

  for (let s = 0; s < scanCount; s++) {
    if (cursor + 4 > bytes.length) throw fail('HDR_TRUNCATED', 'Radiance scanline: incomplete');
    const b0 = bytes[cursor], b1 = bytes[cursor + 1], b2 = bytes[cursor + 2], b3 = bytes[cursor + 3];

    if (scanWidth >= 8 && scanWidth <= 0x7fff && b0 === 2 && b1 === 2 && (b2 & 0x80) === 0) {
      const encodedWidth = (b2 << 8) | b3;
      if (encodedWidth !== scanWidth) {
        throw fail('HDR_MALFORMED', `Radiance RLE width: ${encodedWidth} vs ${scanWidth}`);
      }
      cursor += 4;
      for (let ch = 0; ch < 4; ch++) {
        let x = 0;
        while (x < scanWidth) {
          if (cursor >= bytes.length) throw fail('HDR_TRUNCATED', 'Radiance RLE: incomplete');
          const code = bytes[cursor++];
          if (code > 128) {
            const run = code - 128;
            if (cursor >= bytes.length || x + run > scanWidth) {
              throw fail('HDR_MALFORMED', 'Radiance RLE run: bounds');
            }
            const val = bytes[cursor++];
            for (let k = 0; k < run; k++, x++) rowRgbe[x * 4 + ch] = val;
          } else {
            if (code === 0 || cursor + code > bytes.length || x + code > scanWidth) {
              throw fail('HDR_MALFORMED', 'Radiance RLE literal: bounds');
            }
            for (let k = 0; k < code; k++, x++) rowRgbe[x * 4 + ch] = bytes[cursor++];
          }
        }
      }
      all.set(rowRgbe, s * scanWidth * 4);
      continue;
    }

    for (let x = 0; x < scanWidth; x++) {
      if (cursor + 4 > bytes.length) throw fail('HDR_TRUNCATED', 'Radiance scanline: incomplete');
      if (bytes[cursor] === 1 && bytes[cursor + 1] === 1 && bytes[cursor + 2] === 1) throw fail('HDR_UNSUPPORTED', 'Radiance RLE: old-style unsupported');
      rowRgbe.set(bytes.subarray(cursor, cursor + 4), x * 4);
      cursor += 4;
    }
    all.set(rowRgbe, s * scanWidth * 4);
  }
  if (cursor !== bytes.length) throw fail('HDR_MALFORMED', 'Radiance picture: trailing bytes');
  return all;
}


const EXP_SCALE = new Float64Array(256);
for (let e = 1; e < 256; e++) EXP_SCALE[e] = 2 ** (e - 136);


const PRESETS = [
  ['srgb', [0.64, 0.33, 0.30, 0.60, 0.15, 0.06, 0.3127, 0.3290]],
  ['display-p3', [0.68, 0.32, 0.265, 0.69, 0.15, 0.06, 0.3127, 0.3290]],
  ['rec2020', [0.708, 0.292, 0.170, 0.797, 0.131, 0.046, 0.3127, 0.3290]],
];
const near = (a, b, tolerance) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance);
function admitChromaticities(vals, label) {
  const scaled = vals.map(v => {
    if (!Number.isFinite(v)) throw fail('HDR_MALFORMED', `${label}: finite`);
    const s = Math.round(v * 1000000);
    if (s < -2097152 || s > 2097151) throw fail('HDR_MALFORMED', `${label}: out of range`);
    return s;
  });
  if (!scaled[1] || !scaled[3] || !scaled[5] || scaled[7] <= 0)
    throw fail('HDR_MALFORMED', `${label}: positive white and nonzero y`);
  if ((scaled[0] - scaled[4]) * (scaled[3] - scaled[5]) === (scaled[2] - scaled[4]) * (scaled[1] - scaled[5]))
    throw fail('HDR_MALFORMED', `${label}: collinear primaries`);
}
function colour(vals, tolerance, label = 'EXR chromaticities') {
  admitChromaticities(vals, label);
  const preset = PRESETS.find(([, ref]) => near(vals, ref, tolerance));
  if (preset) return {colorSpace: preset[0]};
  const q = vals.map(v => Math.round(v * 1000000));
  if (q.some(v => !Number.isFinite(v) || v < -2097152 || v > 2097151) || !q[1] || !q[3] || !q[5] || !q[7])
    throw fail('HDR_MALFORMED', 'PRIMARIES: invalid chromaticity');
  if ((q[0] - q[4]) * (q[3] - q[5]) === (q[2] - q[4]) * (q[1] - q[5]))
    throw fail('HDR_MALFORMED', 'PRIMARIES: collinear color triangle');
  const white = near(vals.slice(6), [0.3127, 0.3290], tolerance) ? 'd65' : near(vals.slice(6), [1 / 3, 1 / 3], tolerance) ? 'e' : [vals[6], vals[7]];
  return {colorEncoding: {space: 'rgb', whitePoint: white, primaries: [[vals[0], vals[1]], [vals[2], vals[3]], [vals[4], vals[5]]]}};
}

function box(dv, start, label, most) {
  const minX = dv.getInt32(start, true), minY = dv.getInt32(start + 4, true), maxX = dv.getInt32(start + 8, true), maxY = dv.getInt32(start + 12, true);
  const width = maxX - minX + 1, height = maxY - minY + 1;
  if (width < 1 || height < 1) throw fail('HDR_DIMENSIONS', `EXR ${label}: positive dimensions`);
  if (most !== undefined && width * height > most) throw fail('HDR_DIMENSIONS', `EXR ${label}: exceeds maxPixels ${most}`);
  return {minX, minY, maxX, maxY, width, height};
}
function levelSize(full, level, roundUp) {
  let size = full;
  for (let i = 0; i < level; i++) size = size <= 1 ? 1 : roundUp ? Math.ceil(size / 2) : Math.floor(size / 2);
  return Math.max(1, size);
}
function levelCount(full, roundUp) {
  let count = 1;
  for (let size = full; size > 1; count++) size = roundUp ? Math.ceil(size / 2) : Math.floor(size / 2);
  return count;
}


function huffman(src, count) {
  const malformed = () => fail('HDR_MALFORMED', 'EXR Huffman block: malformed');
  if (src.length < 20) throw malformed();
  const word = at => (src[at] | src[at + 1] << 8 | src[at + 2] << 16 | src[at + 3] << 24) >>> 0;
  const low = word(0), high = word(4), dataBits = word(12);
  if (low > high || high > 65536) throw malformed();
  const peek = (base, at, n) => {
    const b = base + (at >>> 3), v = (src[b] ?? 0) << 16 | (src[b + 1] ?? 0) << 8 | (src[b + 2] ?? 0);
    return (v >>> (24 - n - (at & 7))) & ((1 << n) - 1);
  };
  const lengths = new Uint8Array(65537), perLength = new Uint32Array(54);
  let at = 0;
  for (let i = low; i <= high;) {
    if (20 + (at + 6 >> 3) > src.length) throw malformed();
    const l = peek(20, at, 6); at += 6;
    if (l >= 59) {
      let run = l - 57;
      if (l === 63) { if (20 + (at + 8 >> 3) > src.length) throw malformed(); run = peek(20, at, 8) + 6; at += 8; }
      if (i + run > high + 1) throw malformed();
      i += run;
    } else if (l > 52) throw fail('HDR_UNSUPPORTED', 'EXR Huffman: max 52 bits');
    else { lengths[i++] = l; if (l) perLength[l]++; }
  }
  const base = 20 + Math.ceil(at / 8);
  if (base + Math.ceil(dataBits / 8) > src.length) throw malformed();
  const first = new Float64Array(54), start = new Uint32Array(55);
  for (let l = 52, c = 0; l >= 1; l--) { first[l] = c; c = Math.floor((c + perLength[l]) / 2); }
  for (let l = 1; l <= 52; l++) start[l + 1] = start[l] + perLength[l];
  const symbols = new Uint32Array(start[53]), fill = start.slice();
  for (let i = low; i <= high; i++) if (lengths[i]) symbols[fill[lengths[i]]++] = i;
  const FAST = 12, table = new Int32Array(1 << FAST).fill(-1);
  for (let l = 1; l <= FAST; l++) for (let k = 0; k < perLength[l]; k++) {
    const from = (first[l] + k) * (1 << (FAST - l));
    if (from + (1 << (FAST - l)) > 1 << FAST) throw malformed();
    table.fill(symbols[start[l] + k] * 64 + l, from, from + (1 << (FAST - l)));
  }
  if (count > dataBits * 29) throw malformed();
  const out = new Uint16Array(count);
  let o = 0;
  for (at = 0; at < dataBits;) {
    let symbol = -1, length = 0;
    const entry = table[peek(base, at, FAST)];
    if (entry >= 0) { symbol = entry >>> 6; length = entry & 63; }
    else {
      let code = peek(base, at, FAST);
      for (length = FAST + 1; length <= 52; length++) {
        code = code * 2 + peek(base, at + length - 1, 1);
        const k = code - first[length];
        if (k >= 0 && k < perLength[length]) { symbol = symbols[start[length] + k]; break; }
      }
      if (symbol < 0) throw malformed();
    }
    at += length;
    if (at > dataBits) throw malformed();
    if (symbol === high) {
      if (at + 8 > dataBits || o === 0) throw malformed();
      const run = peek(base, at, 8); at += 8;
      if (o + run > count) throw malformed();
      out.fill(out[o - 1], o, o + run); o += run;
    } else {
      if (o >= count) throw malformed();
      out[o++] = symbol;
    }
  }
  if (o !== count) throw malformed();
  return out;
}

function unwavelet(w, at, nx, ox, ny, oy, max) {
  const w14 = max < 1 << 14;
  const dec = w14
    ? (l, h) => { const hs = (h << 16) >> 16, a = ((l << 16) >> 16) + (hs & 1) + (hs >> 1); return [a & 0xffff, (a - hs) & 0xffff]; }
    : (l, h) => { const b = (l - (h >> 1)) & 0xffff; return [(h + b - 32768) & 0xffff, b]; };
  const n = Math.min(nx, ny);
  let p = 1;
  while (p <= n) p <<= 1;
  p >>= 1;
  let p2 = p;
  p >>= 1;
  for (; p >= 1; p2 = p, p >>= 1) {
    const oy1 = oy * p, oy2 = oy * p2, ox1 = ox * p, ox2 = ox * p2, ey = at + oy * (ny - p2);
    let py = at;
    for (; py <= ey; py += oy2) {
      const ex = py + ox * (nx - p2);
      let px = py;
      for (; px <= ex; px += ox2) {
        const p01 = px + ox1, p10 = px + oy1, p11 = p10 + ox1;
        const [i00, i10] = dec(w[px], w[p10]), [i01, i11] = dec(w[p01], w[p11]);
        [w[px], w[p01]] = dec(i00, i01);
        [w[p10], w[p11]] = dec(i10, i11);
      }
      if (nx & p) { const p10 = px + oy1; [w[px], w[p10]] = dec(w[px], w[p10]); }
    }
    if (ny & p) {
      const ex = py + ox * (nx - p2);
      for (let px = py; px <= ex; px += ox2) { const p01 = px + ox1; [w[px], w[p01]] = dec(w[px], w[p01]); }
    }
  }
}

const sampleCount = (s, a, b) => Math.floor(b / s) - Math.floor((a - 1) / s);
const keeps = (v, s) => ((v % s) + s) % s === 0;
const blockBytes = (chunk, channels, bytes = c => c.sampleBytes) => channels.reduce((sum, c) => sum + sampleCount(c.xs, chunk.x, chunk.x + chunk.width - 1) * sampleCount(c.ys, chunk.y, chunk.y + chunk.rows - 1) * bytes(c), 0);
const pxr24Bytes = c => c.kind === 2 ? 3 : c.sampleBytes;
function layout(chunk, channels) {
  const nx = channels.map(c => sampleCount(c.xs, chunk.x, chunk.x + chunk.width - 1));
  const ny = channels.map(c => sampleCount(c.ys, chunk.y, chunk.y + chunk.rows - 1));
  const rowAt = [];
  let at = 0;
  for (let r = 0; r < chunk.rows; r++) {
    const row = new Float64Array(channels.length).fill(-1);
    for (let c = 0; c < channels.length; c++) if (keeps(chunk.y + r, channels[c].ys)) { row[c] = at; at += nx[c] * channels[c].sampleBytes; }
    rowAt.push(row);
  }
  return {nx, ny, rowAt};
}

function interleave(planes, chunk, channels, expected) {
  const out = new Uint8Array(expected), {nx, rowAt} = chunk.geo, seen = new Array(channels.length).fill(0), starts = [];
  for (let c = 0, s = 0; c < channels.length; c++) { starts.push(s); s += nx[c] * chunk.geo.ny[c] * channels[c].sampleBytes; }
  for (let r = 0; r < chunk.rows; r++) for (let c = 0; c < channels.length; c++) {
    const at = rowAt[r][c];
    if (at < 0) continue;
    const n = nx[c] * channels[c].sampleBytes, from = starts[c] + seen[c]++ * n;
    out.set(planes.subarray(from, from + n), at);
  }
  return out;
}
const wordsToBytes = words => {
  if (LITTLE) return new Uint8Array(words.buffer, words.byteOffset, words.byteLength);
  const out = new Uint8Array(words.length * 2);
  for (let i = 0; i < words.length; i++) { out[2 * i] = words[i] & 255; out[2 * i + 1] = words[i] >>> 8; }
  return out;
};

function piz(packed, chunk, channels, expected) {
  const malformed = () => fail('HDR_MALFORMED', 'EXR PIZ block: malformed');
  if (packed.length < 8) throw malformed();
  const min = packed[0] | packed[1] << 8, max = packed[2] | packed[3] << 8;
  if (max >= 8192) throw malformed();
  const bitmap = new Uint8Array(8192);
  let p = 4;
  if (min <= max) {
    if (p + max - min + 1 > packed.length) throw malformed();
    bitmap.set(packed.subarray(p, p + max - min + 1), min);
    p += max - min + 1;
  }
  bitmap[0] &= 0xfe;
  const lut = new Uint16Array(65536);
  let values = 0;
  for (let i = 0; i < 65536; i++) if (i === 0 || bitmap[i >> 3] & (1 << (i & 7))) lut[values++] = i;
  if (p + 4 > packed.length) throw malformed();
  const length = packed[p] | packed[p + 1] << 8 | packed[p + 2] << 16 | packed[p + 3] << 24;
  p += 4;
  if (!values || length < 0 || p + length !== packed.length) throw malformed();
  const words = huffman(packed.subarray(p, p + length), expected / 2);
  for (let c = 0, at = 0; c < channels.length; c++) {
    const size = channels[c].sampleBytes >> 1;
    const nx = chunk.geo.nx[c], ny = chunk.geo.ny[c];
    for (let j = 0; j < size; j++) unwavelet(words, at + j, nx, size, ny, nx * size, values - 1);
    at += nx * ny * size;
  }
  for (let i = 0; i < words.length; i++) {
    if (words[i] >= values) throw malformed();
    words[i] = lut[words[i]];
  }
  return interleave(wordsToBytes(words), chunk, channels, expected);
}

async function pxr24(packed, chunk, channels, expected) {
  const planeBytes = channels.map(pxr24Bytes), {rowAt, nx} = chunk.geo;
  const inflated = await inflateExact(packed, blockBytes(chunk, channels, pxr24Bytes));
  const out = new Uint8Array(expected);
  let src = 0;
  for (let y = 0; y < chunk.rows; y++) for (let c = 0; c < channels.length; c++) {
    const o = rowAt[y][c];
    if (o < 0) continue;
    const planes = planeBytes[c], size = channels[c].sampleBytes, n = nx[c];
    let pixel = 0;
    for (let x = 0; x < n; x++) {
      let diff = 0;
      for (let k = 0; k < planes; k++) diff = diff * 256 + inflated[src + k * n + x];
      if (channels[c].kind === 2) diff *= 256;
      else if (size === 2) diff = diff & 0xffff;
      pixel = (pixel + diff) % (size === 2 ? 65536 : 4294967296);
      for (let k = 0; k < size; k++) out[o + x * size + k] = Math.floor(pixel / 2 ** (8 * k)) & 255;
    }
    src += planes * n;
  }
  return out;
}

let B44_LOG = null;
function b44Log() {
  if (B44_LOG) return B44_LOG;
  const t = new Uint16Array(65536);
  for (let x = 0; x < 65536; x++) {
    if ((x & 0x7c00) === 0x7c00 || x > 0x8000) continue;
    t[x] = floatToHalfBits(fr(8 * fr(Math.log(halfValue(x)))));
  }
  return (B44_LOG = t);
}
function b44(packed, chunk, channels, expected) {
  const malformed = () => fail('HDR_MALFORMED', 'EXR B44 block: malformed');
  const planes = new Uint8Array(expected), s = new Uint16Array(16);
  let p = 0, o = 0;
  for (let c = 0; c < channels.length; c++) {
    const channel = channels[c], nx = chunk.geo.nx[c], ny = chunk.geo.ny[c];
    if (channel.kind !== 1) {
      const n = nx * ny * channel.sampleBytes;
      if (p + n > packed.length) throw malformed();
      planes.set(packed.subarray(p, p + n), o); p += n; o += n;
      continue;
    }
    const log = channel.linear ? b44Log() : null;
    for (let by = 0; by < ny; by += 4) for (let bx = 0; bx < nx; bx += 4) {
      if (p + 3 > packed.length) throw malformed();
      const b = packed;
      if (b[p + 2] >= 13 << 2) {
        s.fill((b[p] << 8) | b[p + 1]);
        p += 3;
      } else {
        if (p + 14 > packed.length) throw malformed();
        const q = i => b[p + i], shift = q(2) >> 2, bias = 0x20 << shift;
        const step = (from, six) => (from + (six << shift) - bias) & 0xffff;
        s[0] = (q(0) << 8) | q(1);
        s[4] = step(s[0], ((q(2) << 4) | (q(3) >> 4)) & 0x3f);
        s[8] = step(s[4], ((q(3) << 2) | (q(4) >> 6)) & 0x3f);
        s[12] = step(s[8], q(4) & 0x3f);
        s[1] = step(s[0], q(5) >> 2);
        s[5] = step(s[4], ((q(5) << 4) | (q(6) >> 4)) & 0x3f);
        s[9] = step(s[8], ((q(6) << 2) | (q(7) >> 6)) & 0x3f);
        s[13] = step(s[12], q(7) & 0x3f);
        s[2] = step(s[1], q(8) >> 2);
        s[6] = step(s[5], ((q(8) << 4) | (q(9) >> 4)) & 0x3f);
        s[10] = step(s[9], ((q(9) << 2) | (q(10) >> 6)) & 0x3f);
        s[14] = step(s[13], q(10) & 0x3f);
        s[3] = step(s[2], q(11) >> 2);
        s[7] = step(s[6], ((q(11) << 4) | (q(12) >> 4)) & 0x3f);
        s[11] = step(s[10], ((q(12) << 2) | (q(13) >> 6)) & 0x3f);
        s[15] = step(s[14], q(13) & 0x3f);
        p += 14;
      }
      for (let i = 0; i < 16; i++) s[i] = s[i] & 0x8000 ? s[i] & 0x7fff : ~s[i];
      if (log) for (let i = 0; i < 16; i++) s[i] = log[s[i]];
      for (let y = 0; y < 4 && by + y < ny; y++) for (let x = 0; x < 4 && bx + x < nx; x++) {
        const at = o + ((by + y) * nx + bx + x) * 2, v = s[y * 4 + x];
        planes[at] = v & 255; planes[at + 1] = v >>> 8;
      }
    }
    o += nx * ny * 2;
  }
  if (p !== packed.length) throw malformed();
  return interleave(planes, chunk, channels, expected);
}

const F32 = new DataView(new ArrayBuffer(4));
const halfValue = h => { F32.setUint32(0, halfBitsToFloat32Bits(h)); return F32.getFloat32(0); };
const fr = Math.fround;
function floatToHalfBits(f) {
  F32.setFloat32(0, f); const x = F32.getUint32(0);
  const sign = (x >>> 16) & 0x8000, exp = (x >>> 23) & 0xff, man = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (man ? 0x200 : 0);
  let e = exp - 112;
  if (e >= 31) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    const full = man | 0x800000, shift = 14 - e, mant = full >>> shift;
    const rem = full & ((1 << shift) - 1), half = 1 << (shift - 1);
    return (sign | mant) + (rem > half || (rem === half && (mant & 1)) ? 1 : 0);
  }
  const half = sign | (e << 10) | (man >>> 13), rem = man & 0x1fff;
  return half + (rem > 0x1000 || (rem === 0x1000 && (half & 1)) ? 1 : 0);
}
let DWA_TO_LINEAR = null;
function dwaToLinear() {
  if (DWA_TO_LINEAR) return DWA_TO_LINEAR;
  const t = new Uint16Array(65536);
  for (let x = 0; x < 65536; x++) {
    if (x === 0 || (x & 0x7c00) === 0x7c00) continue;
    let f = fr(halfValue(x)); const sign = f < 0 ? -1 : 1; f = Math.abs(f);
    const px = f <= 1 ? f : 9.02501329156, py = f <= 1 ? 2.2 : f - 1;
    t[x] = floatToHalfBits(fr(sign * fr(Math.pow(fr(px), fr(py)))));
  }
  return (DWA_TO_LINEAR = t);
}
const DCT_A = fr(0.5*Math.cos(3.14159/4)), DCT_B = fr(0.5*Math.cos(3.14159/16)), DCT_C = fr(0.5*Math.cos(3.14159/8)),
  DCT_D = fr(0.5*Math.cos(3*3.14159/16)), DCT_E = fr(0.5*Math.cos(5*3.14159/16)), DCT_F = fr(0.5*Math.cos(3*3.14159/8)), DCT_G = fr(0.5*Math.cos(7*3.14159/16));
function idct8x8(d) {
  const al = [0,0,0,0], be = [0,0,0,0], th = [0,0,0,0], ga = [0,0,0,0];
  for (let pass = 0; pass < 2; pass++) {
    const st = pass === 0 ? 1 : 8, big = pass === 0 ? 8 : 1;
    for (let k = 0; k < 8; k++) {
      const o = pass === 0 ? k * 8 : k;
      const g0 = d[o], g1 = d[o+st], g2 = d[o+2*st], g3 = d[o+3*st], g4 = d[o+4*st], g5 = d[o+5*st], g6 = d[o+6*st], g7 = d[o+7*st];
      al[0]=fr(DCT_C*g2); al[1]=fr(DCT_F*g2); al[2]=fr(DCT_C*g6); al[3]=fr(DCT_F*g6);
      be[0]=fr(fr(fr(fr(DCT_B*g1)+fr(DCT_D*g3))+fr(DCT_E*g5))+fr(DCT_G*g7));
      be[1]=fr(fr(fr(fr(DCT_D*g1)-fr(DCT_G*g3))-fr(DCT_B*g5))-fr(DCT_E*g7));
      be[2]=fr(fr(fr(fr(DCT_E*g1)-fr(DCT_B*g3))+fr(DCT_G*g5))+fr(DCT_D*g7));
      be[3]=fr(fr(fr(fr(DCT_G*g1)-fr(DCT_E*g3))+fr(DCT_D*g5))-fr(DCT_B*g7));
      th[0]=fr(DCT_A*fr(g0+g4)); th[3]=fr(DCT_A*fr(g0-g4)); th[1]=fr(al[0]+al[3]); th[2]=fr(al[1]-al[2]);
      ga[0]=fr(th[0]+th[1]); ga[1]=fr(th[3]+th[2]); ga[2]=fr(th[3]-th[2]); ga[3]=fr(th[0]-th[1]);
      d[o]=fr(ga[0]+be[0]); d[o+st]=fr(ga[1]+be[1]); d[o+2*st]=fr(ga[2]+be[2]); d[o+3*st]=fr(ga[3]+be[3]);
      d[o+4*st]=fr(ga[3]-be[3]); d[o+5*st]=fr(ga[2]-be[2]); d[o+6*st]=fr(ga[1]-be[1]); d[o+7*st]=fr(ga[0]-be[0]);
    }
  }
}
const DWA_ZIG = [0,1,5,6,14,15,27,28,2,4,7,13,16,26,29,42,3,8,12,17,25,30,41,43,9,11,18,24,31,40,44,53,10,19,23,32,39,45,52,54,20,22,33,38,46,51,55,60,21,34,37,47,50,56,59,61,35,36,48,49,57,58,62,63];
const DEFAULT_RULES = [['R',1,1,0],['R',1,2,0],['G',1,1,1],['G',1,2,1],['B',1,1,2],['B',1,2,2],['Y',1,1,-1],['Y',1,2,-1],['BY',1,1,-1],['BY',1,2,-1],['RY',1,1,-1],['RY',1,2,-1],['A',2,0,-1],['A',2,1,-1],['A',2,2,-1]];

async function dwa(packed, chunk, channels, expected) {
  const malformed = () => fail('HDR_MALFORMED', 'EXR DWA block: malformed');
  if (packed.length < 88) throw malformed();
  const dv = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  const sz = []; for (let i = 0; i < 11; i++) { const v = Number(dv.getBigUint64(i * 8, true)); if (v < 0 || !Number.isSafeInteger(v)) throw malformed(); sz.push(v); }
  const version = sz[0]; if (version > 2) throw fail('HDR_UNSUPPORTED', 'EXR DWA version: max 2');
  let p = 88, rules = DEFAULT_RULES;
  if (version >= 2) {
    if (p + 2 > packed.length) throw malformed();
    const ruleSize = dv.getUint16(p, true), end = p + ruleSize;
    if (ruleSize < 2 || end > packed.length) throw malformed();
    let q = p + 2; rules = [];
    while (q < end) {
      let s = '';
      while (q < end && packed[q] !== 0) s += String.fromCharCode(packed[q++]);
      if (q >= end || q + 3 > end) throw malformed();
      q++;
      const value = packed[q++], type = packed[q++], rsch = (value >> 2) & 3, rcsc = (value >> 4) - 1;
      if (rsch > 2 || rcsc > 2 || type > 2 || rcsc >= 0 && rsch !== 1) throw malformed();
      rules.push([s, rsch, type, rcsc, value & 1]);
    }
    p = end;
  }
  const [, unkUnc, unkC, acC, dcC, rleC, rleUnc, rleRaw, acCnt, dcCnt, acComp] = sz;
  let off = p; const unkOff = off; off += unkC; const acOff = off; off += acC; const dcOff = off; off += dcC; const rleOff = off; off += rleC;
  if (off !== packed.length) throw malformed();
  if (acComp > 1) throw malformed();
  if (unkUnc > expected || rleRaw > expected || rleUnc > 2 * rleRaw || acCnt > expected || dcCnt > expected) throw fail('HDR_LIMIT', 'EXR DWA: too large');
  const suffix = n => { const i = n.lastIndexOf('.'); return i < 0 ? n : n.slice(i + 1); };
  const prefix = n => { const i = n.lastIndexOf('.'); return i < 0 ? '' : n.slice(0, i); };
  const scheme = new Array(channels.length).fill(0), cscMap = new Map();
  channels.forEach((ch, c) => {
    const suf = suffix(ch.name);
    for (const [rs, rsch, rtype, rcsc, rcase] of rules) {
      if (rtype !== ch.kind) continue;
      if (rcase ? suf.toLowerCase() === rs.toLowerCase() : suf === rs) {
        scheme[c] = rsch;
        if (rcsc >= 0) {
          const pf = prefix(ch.name);
          if (!cscMap.has(pf)) cscMap.set(pf, [-1, -1, -1]);
          const set = cscMap.get(pf);
          if (set[rcsc] >= 0) throw malformed();
          set[rcsc] = c;
        }
        break;
      }
    }
  });
  const cscSets = [];
  for (const [, idx] of cscMap) if (idx[0] >= 0 && idx[1] >= 0 && idx[2] >= 0) cscSets.push(idx);
  const unknown = unkC > 0 ? await inflateExact(packed.subarray(unkOff, unkOff + unkC), unkUnc) : new Uint8Array(0);
  let ac = new Uint16Array(0);
  if (acC > 0) { if (acComp === 0) ac = huffman(packed.subarray(acOff, acOff + acC), acCnt); else { const b = await inflateExact(packed.subarray(acOff, acOff + acC), acCnt * 2); ac = new Uint16Array(b.buffer, b.byteOffset, acCnt); } }
  let dc = new Uint16Array(0);
  if (dcC > 0) { const rec = undoBytePrediction(await inflateExact(packed.subarray(dcOff, dcOff + dcC), dcCnt * 2)); dc = new Uint16Array(rec.buffer, rec.byteOffset, dcCnt); }
  else if (dcCnt !== 0) throw malformed();
  let rle = new Uint8Array(0);
  if (rleRaw > 0) rle = unrollRle(await inflateExact(packed.subarray(rleOff, rleOff + rleC), rleUnc), rleRaw);
  const toLinear = dwaToLinear();
  const {nx: NX, ny: NY} = chunk.geo, planes = new Uint8Array(expected), planeAt = [];
  for (let c = 0, s0 = 0; c < channels.length; c++) { planeAt.push(s0); s0 += NX[c] * NY[c] * channels[c].sampleBytes; }
  const out = planes;
  const writeHalf = (c, x, y, h) => {
    const ch = channels[c], at = planeAt[c] + (y * NX[c] + x) * ch.sampleBytes;
    if (ch.sampleBytes === 2) { out[at] = h & 255; out[at + 1] = h >>> 8; }
    else { F32.setUint32(0, halfBitsToFloat32Bits(h)); const b = F32.getUint32(0); out[at] = b & 255; out[at + 1] = (b >>> 8) & 255; out[at + 2] = (b >>> 16) & 255; out[at + 3] = (b >>> 24) & 255; }
  };
  let acPos = 0, dcPos = 0, rlePos = 0, unkPos = 0; const processed = new Array(channels.length).fill(false);
  const decodeLossy = comps => {
    const W = NX[comps[0]], H = NY[comps[0]], nbx = Math.ceil(W / 8), nby = Math.ceil(H / 8);
    if (comps.some(c => NX[c] !== W || NY[c] !== H)) throw malformed();
    const dcOffC = comps.map((_, k) => dcPos + k * nbx * nby);
    const dct = comps.map(() => new Float64Array(64)), zig = comps.map(() => new Uint16Array(64)), rowBlk = comps.map(() => new Uint16Array(nbx * 64));
    for (let by = 0; by < nby; by++) {
      const maxY = by === nby - 1 ? H - (nby - 1) * 8 : 8;
      for (let bx = 0; bx < nbx; bx++) {
        for (let k = 0; k < comps.length; k++) {
          zig[k].fill(0);
          if (dcOffC[k] >= dc.length) throw malformed();
          zig[k][0] = dc[dcOffC[k]++]; dcPos++;
          let i = 1; while (i < 64) { if (acPos >= ac.length) throw malformed(); const v = ac[acPos++]; if ((v & 0xff00) === 0xff00) { const cnt = v & 0xff; i += cnt === 0 ? 64 : cnt; } else { if (i < 64) zig[k][i] = v; i++; } }
          const dd = dct[k]; for (let j = 0; j < 64; j++) dd[j] = fr(halfValue(zig[k][DWA_ZIG[j]]));
          idct8x8(dd);
        }
        if (comps.length === 3) { const r = dct[0], g = dct[1], b = dct[2]; for (let i = 0; i < 64; i++) { const s0 = r[i], s1 = g[i], s2 = b[i]; r[i] = fr(s0 + fr(1.5747 * s2)); g[i] = fr(fr(s0 - fr(0.1873 * s1)) - fr(0.4682 * s2)); b[i] = fr(s0 + fr(1.8556 * s1)); } }
        for (let k = 0; k < comps.length; k++) { const rb = rowBlk[k], dd = dct[k]; for (let i = 0; i < 64; i++) rb[bx * 64 + i] = floatToHalfBits(dd[i]); }
      }
      for (let k = 0; k < comps.length; k++) {
        const c = comps[k], lut = channels[c].linear ? null : toLinear, rb = rowBlk[k];
        for (let y = 8 * by; y < 8 * by + maxY; y++) for (let bx = 0; bx < nbx; bx++) {
          const cols = bx === nbx - 1 ? W - (nbx - 1) * 8 : 8, src = bx * 64 + (y & 7) * 8;
          for (let x = 0; x < cols; x++) { const v = rb[src + x]; writeHalf(c, bx * 8 + x, y, lut ? lut[v] : v); }
        }
      }
    }
    for (const c of comps) processed[c] = true;
  };
  for (const set of cscSets) decodeLossy(set);
  for (let c = 0; c < channels.length; c++) {
    if (processed[c]) continue;
    const ch = channels[c], n = NX[c] * NY[c], ps = ch.sampleBytes;
    if (scheme[c] === 1) decodeLossy([c]);
    else if (scheme[c] === 2) {
      if (rlePos + n * ps > rle.length) throw malformed();
      const bytePlanes = []; for (let b = 0; b < ps; b++) { bytePlanes.push(rle.subarray(rlePos, rlePos + n)); rlePos += n; }
      for (let i = 0; i < n; i++) for (let b = 0; b < ps; b++) out[planeAt[c] + i * ps + b] = bytePlanes[b][i];
      processed[c] = true;
    } else {
      if (unkPos + n * ps > unknown.length) throw malformed();
      out.set(unknown.subarray(unkPos, unkPos + n * ps), planeAt[c]);
      unkPos += n * ps; processed[c] = true;
    }
  }
  if (acPos !== ac.length || dcPos !== dc.length || rlePos !== rle.length || unkPos !== unknown.length) throw malformed();
  return interleave(planes, chunk, channels, expected);
}


const YCA_TAPS = [0.002128, -0.007540, 0.019597, -0.043159, 0.087929, -0.186077, 0.627123, 0.627123, -0.186077, 0.087929, -0.043159, 0.019597, -0.007540, 0.002128].map(fr);
const stdMax = (a, b) => (a < b ? b : a), stdMin = (a, b) => (b < a ? b : a);
function luminanceWeights(c) {
  const [rx, ry, gx, gy, bx, by, wx, wy] = c.map(fr);
  const X = fr(fr(wx * 1) / wy), Z = fr(fr(fr(fr(1 - wx) - wy) * 1) / wy), XZ = fr(X + Z);
  const d = fr(fr(fr(rx * fr(by - gy)) + fr(bx * fr(gy - ry))) + fr(gx * fr(ry - by)));
  const sr = fr(fr(fr(fr(X * fr(by - gy)) - fr(gx * fr(fr(1 * fr(by - 1)) + fr(by * XZ)))) + fr(bx * fr(fr(1 * fr(gy - 1)) + fr(gy * XZ)))) / d);
  const sg = fr(fr(fr(fr(X * fr(ry - by)) + fr(rx * fr(fr(1 * fr(by - 1)) + fr(by * XZ)))) - fr(bx * fr(fr(1 * fr(ry - 1)) + fr(ry * XZ)))) / d);
  const sb = fr(fr(fr(fr(X * fr(gy - ry)) - fr(rx * fr(fr(1 * fr(gy - 1)) + fr(gy * XZ)))) + fr(gx * fr(fr(1 * fr(ry - 1)) + fr(ry * XZ)))) / d);
  const m = [fr(sr * ry), fr(sg * gy), fr(sb * by)], sum = fr(fr(m[0] + m[1]) + m[2]);
  if (!Number.isFinite(sum) || sum <= 0 || m.some(v => !(v > 0))) throw fail('HDR_MALFORMED', 'EXR chromaticities: no luminance');
  return m.map(v => fr(v / sum));
}
function lumaChromaToRgba(Y, RY, BY, A, W, H, minY, yw) {
  const maxY = minY + H - 1, cw = W / 2, out = new Uint16Array(W * H * 4);
  const rows = new Map(), rgba = new Map();
  const readRow = y => {
    const yc = y < minY ? minY : y > maxY ? maxY - 1 : y;
    let row = rows.get(yc);
    if (row) return row;
    const at = (yc - minY) * W, r = new Uint16Array(W), b = new Uint16Array(W);
    if (!(yc & 1)) {
      const base = Math.floor((yc - minY) / 2) * cw, col = x => base + Math.floor((x < 0 ? 0 : x >= W ? W - 2 : x) / 2);
      for (let j = 0; j < W; j++) {
        if (!(j & 1)) { r[j] = RY[col(j)]; b[j] = BY[col(j)]; continue; }
        let sr = 0, sb = 0;
        for (let k = 0; k < 14; k++) { const x = col(j - 13 + 2 * k); sr = fr(sr + fr(halfValue(RY[x]) * YCA_TAPS[k])); sb = fr(sb + fr(halfValue(BY[x]) * YCA_TAPS[k])); }
        r[j] = floatToHalfBits(sr); b[j] = floatToHalfBits(sb);
      }
    }
    row = {r, b, g: Y.subarray(at, at + W), a: A.subarray(at, at + W)};
    rows.set(yc, row);
    return row;
  };
  const rgbaRow = y => {
    let row = rgba.get(y);
    if (row) return row;
    const center = readRow(y), o = new Uint16Array(W * 4);
    let rr = center.r, bb = center.b;
    if (y & 1) {
      const taps = Array.from({length: 14}, (_, k) => readRow(y - 13 + 2 * k));
      rr = new Uint16Array(W); bb = new Uint16Array(W);
      for (let i = 0; i < W; i++) {
        let sr = 0, sb = 0;
        for (let k = 0; k < 14; k++) { sr = fr(sr + fr(halfValue(taps[k].r[i]) * YCA_TAPS[k])); sb = fr(sb + fr(halfValue(taps[k].b[i]) * YCA_TAPS[k])); }
        rr[i] = floatToHalfBits(sr); bb[i] = floatToHalfBits(sb);
      }
    }
    for (let i = 0; i < W; i++) {
      const cr = halfValue(rr[i]), cb = halfValue(bb[i]), g = center.g[i];
      o[i * 4 + 3] = center.a[i];
      if (cr === 0 && cb === 0) { o[i * 4] = o[i * 4 + 1] = o[i * 4 + 2] = g; continue; }
      const Yv = halfValue(g), R = fr(fr(cr + 1) * Yv), B = fr(fr(cb + 1) * Yv), G = fr(fr(fr(Yv - fr(R * yw[0])) - fr(B * yw[2])) / yw[1]);
      o[i * 4] = floatToHalfBits(R); o[i * 4 + 1] = floatToHalfBits(G); o[i * 4 + 2] = floatToHalfBits(B);
    }
    rgba.set(y, o);
    return o;
  };
  const saturation = (p, i) => {
    const r = halfValue(p[i * 4]), g = halfValue(p[i * 4 + 1]), b = halfValue(p[i * 4 + 2]);
    const hi = stdMax(r, stdMax(g, b)), lo = stdMin(r, stdMin(g, b));
    return hi > 0 ? fr(1 - fr(lo / hi)) : 0;
  };
  for (let y = minY; y <= maxY; y++) {
    const above = rgbaRow(y - 1), mid = rgbaRow(y), below = rgbaRow(y + 1), dst = (y - minY) * W * 4;
    let a2 = saturation(above, 0), a1 = a2, b2 = saturation(below, 0), b1 = b2;
    for (let i = 0; i < W; i++) {
      const a0 = a1; a1 = a2; const b0 = b1; b1 = b2;
      if (i < W - 1) { a2 = saturation(above, i + 1); b2 = saturation(below, i + 1); }
      const mean = stdMin(1, fr(0.25 * fr(fr(fr(a0 + a2) + b0) + b2))), sat = saturation(mid, i), o = dst + i * 4;
      out[o] = mid[i * 4]; out[o + 1] = mid[i * 4 + 1]; out[o + 2] = mid[i * 4 + 2]; out[o + 3] = mid[i * 4 + 3];
      if (sat <= mean) continue;
      const most = stdMin(1, fr(1 - fr(fr(1 - mean) * 0.25)));
      if (sat <= most) continue;
      const f = fr(most / sat), r = halfValue(mid[i * 4]), g = halfValue(mid[i * 4 + 1]), b = halfValue(mid[i * 4 + 2]);
      const hi = stdMax(r, stdMax(g, b));
      const dr = floatToHalfBits(stdMax(fr(hi - fr(fr(hi - r) * f)), 0)), dg = floatToHalfBits(stdMax(fr(hi - fr(fr(hi - g) * f)), 0)), db = floatToHalfBits(stdMax(fr(hi - fr(fr(hi - b) * f)), 0));
      const yin = fr(fr(fr(r * yw[0]) + fr(g * yw[1])) + fr(b * yw[2]));
      const yout = fr(fr(fr(halfValue(dr) * yw[0]) + fr(halfValue(dg) * yw[1])) + fr(halfValue(db) * yw[2]));
      if (yout > 0) {
        const q = fr(yin / yout);
        out[o] = floatToHalfBits(fr(halfValue(dr) * q)); out[o + 1] = floatToHalfBits(fr(halfValue(dg) * q)); out[o + 2] = floatToHalfBits(fr(halfValue(db) * q));
      } else { out[o] = dr; out[o + 1] = dg; out[o + 2] = db; }
    }
    rgba.delete(y - 2); for (const k of rows.keys()) if (k < y - 16) rows.delete(k);
  }
  return out;
}

async function decompressBlock(packed, compression, chunk, channels) {
  const expected = chunk.expected;
  if (packed.byteLength === expected) return packed;
  if (compression === 0) throw fail('HDR_MALFORMED', 'EXR uncompressed: size mismatch');
  if (packed.byteLength > expected) throw fail('HDR_MALFORMED', 'EXR compressed block: too large');
  if (compression === 1) return undoBytePrediction(unrollRle(packed, expected));
  if (compression <= 3) return undoBytePrediction(await inflateExact(packed, expected));
  if (compression === 4) return piz(packed, chunk, channels, expected);
  if (compression === 5) return pxr24(packed, chunk, channels, expected);
  if (compression <= 7) return b44(packed, chunk, channels, expected);
  return dwa(packed, chunk, channels, expected);
}

async function readExr(bytes, windowMode, maxPixels) {
  if (bytes.byteLength < 32) throw fail('HDR_TRUNCATED', 'EXR file: incomplete');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== EXR_MAGIC) throw fail('HDR_FORMAT', 'not OpenEXR: invalid signature');
  const versionWord = dv.getUint32(4, true);
  if ((versionWord & 255) !== 2) throw fail('HDR_UNSUPPORTED', `EXR version ${versionWord & 255}: unsupported`);
  if (versionWord & VERSION_NON_IMAGE) throw fail('HDR_UNSUPPORTED', 'EXR deep: unsupported');
  if (versionWord & ~(VERSION_TILED | VERSION_LONG_NAMES | VERSION_MULTIPART | 255)) throw fail('HDR_MALFORMED', 'EXR version: unknown flags');
  const multipart = Boolean(versionWord & VERSION_MULTIPART);
  const nameLimit = versionWord & VERSION_LONG_NAMES ? 255 : 31;
  let cursor = 8;
  const cString = (end = bytes.length) => {
    const start = cursor;
    while (cursor < end && bytes[cursor] !== 0 && cursor - start <= nameLimit) cursor++;
    if (cursor >= end || cursor - start > nameLimit) throw fail('HDR_MALFORMED', 'EXR name: unterminated or long');
    const text = ascii(bytes, start, cursor);
    cursor++;
    return text;
  };
  const parts = [];
  for (;;) {
    const map = new Map();
    for (;;) {
      if (cursor >= bytes.length) throw fail('HDR_TRUNCATED', 'EXR header: incomplete');
      const name = cString();
      if (!name) break;
      const type = cString();
      if (!type || cursor + 4 > bytes.length || map.has(name)) throw fail('HDR_MALFORMED', `EXR attribute ${name}: invalid or duplicate`);
      const length = dv.getInt32(cursor, true);
      cursor += 4;
      if (length < 0 || cursor + length > bytes.length) throw fail('HDR_MALFORMED', `EXR attribute ${name}: incomplete`);
      map.set(name, {type, start: cursor, length});
      cursor += length;
    }
    parts.push(map);
    if (!multipart) break;
    if (cursor >= bytes.length) throw fail('HDR_TRUNCATED', 'EXR header list: incomplete');
    if (bytes[cursor] === 0) { cursor++; break; }
  }
  const partCount = parts.length;
  const attrFrom = map => (name, type, length, required = true) => {
    const found = map.get(name);
    if (!found) { if (required) throw fail('HDR_MALFORMED', `EXR header: missing ${name}`); return null; }
    if (found.type !== type || (length !== undefined && found.length !== length)) throw fail('HDR_MALFORMED', `EXR ${name}: type or size`);
    return found;
  };
  const isDeep = map => { const t = map.get('type'); return t?.type === 'string' && /deep/.test(ascii(bytes, t.start, t.start + Math.min(t.length, 64))); };
  const partTiled = map => { const t = map.get('type'); return t?.type === 'string' ? /tiled/.test(ascii(bytes, t.start, t.start + Math.min(t.length, 64))) : Boolean(versionWord & VERSION_TILED); };
  let chosen = -1, partTableStart = cursor, allTablesEnd = cursor;
  const tableCounts = [];
  for (let p = 0; p < partCount; p++) {
    if (!isDeep(parts[p]) && parts[p].has('channels') && chosen < 0) { chosen = p; partTableStart = allTablesEnd; }
    if (!multipart) break;
    const found = attrFrom(parts[p])('chunkCount', 'int', 4);
    const count = dv.getInt32(found.start, true);
    if (count < 0) throw fail('HDR_MALFORMED', 'EXR chunkCount: invalid');
    allTablesEnd += count * 8;
    if (allTablesEnd > bytes.byteLength) throw fail('HDR_TRUNCATED', 'EXR offset table: incomplete');
    tableCounts.push(count);
  }
  if (chosen < 0) throw fail('HDR_UNSUPPORTED', parts.some(isDeep) ? 'EXR deep: unsupported' : 'EXR image part: required');
  const attributes = parts[chosen], partNumber = chosen, partPrefix = multipart ? 4 : 0;
  const tableStart = partTableStart;
  const attribute = attrFrom(attributes);
  if (isDeep(attributes)) throw fail('HDR_UNSUPPORTED', 'EXR deep: unsupported');

  const compression = bytes[attribute('compression', 'compression', 1).start];
  if (compression > 9) throw fail('HDR_UNSUPPORTED', compression < 14 ? `EXR ${COMPRESSION_NAMES[compression]} compression: unsupported` : `EXR compression ${compression}: unsupported`);
  const dataWin = box(dv, attribute('dataWindow', 'box2i', 16).start, 'data window', maxPixels);
  const displayWin = box(dv, attribute('displayWindow', 'box2i', 16).start, 'display window', windowMode === 'display' ? maxPixels : undefined);
  const outWin = windowMode === 'display' ? displayWin : dataWin;
  if (bytes[attribute('lineOrder', 'lineOrder', 1).start] > 2) throw fail('HDR_MALFORMED', 'EXR lineOrder: 0-2');

  const chlist = attribute('channels', 'chlist');
  cursor = chlist.start;
  const chEnd = chlist.start + chlist.length, channels = [];
  for (;;) {
    if (cursor >= chEnd) throw fail('HDR_MALFORMED', 'EXR channels: unterminated');
    if (bytes[cursor] === 0) { cursor++; break; }
    const name = cString(chEnd);
    if (cursor + 16 > chEnd) throw fail('HDR_MALFORMED', 'EXR channels: incomplete');
    const kind = dv.getInt32(cursor, true), linear = bytes[cursor + 4], xs = dv.getInt32(cursor + 8, true), ys = dv.getInt32(cursor + 12, true);
    cursor += 16;
    if (kind < 0 || kind > 2) throw fail('HDR_MALFORMED', `EXR ${name} pixel type: 0-2`);
    if (linear > 1) throw fail('HDR_MALFORMED', `EXR ${name} pLinear: 0-1`);
    if (xs < 1 || ys < 1) throw fail('HDR_MALFORMED', `EXR ${name} sampling: positive`);
    if (!keeps(dataWin.minX, xs) || !keeps(dataWin.minY, ys) || dataWin.width % xs || dataWin.height % ys) throw fail('HDR_MALFORMED', `EXR ${name} sampling: divide dataWindow`);
    if (channels.some(channel => channel.name === name)) throw fail('HDR_MALFORMED', 'EXR channels: duplicate');
    channels.push({name, kind, xs, ys, sampleBytes: kind === 1 ? 2 : 4, linear: linear === 1});
  }
  if (cursor !== chEnd || !channels.length) throw fail('HDR_MALFORMED', 'EXR channels: nonempty no trailing');
  channels.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const find = name => channels.findIndex(channel => channel.name === name);
  const rgb = [find('R'), find('G'), find('B')], gray = find('Y'), alphaAt = find('A'), ry = find('RY'), by = find('BY');
  const lumaChroma = !rgb.some(i => i >= 0) && gray >= 0 && ry >= 0 && by >= 0;
  const targets = rgb.some(i => i >= 0) ? rgb.map((c, k) => [c, k]).filter(([c]) => c >= 0) : gray >= 0 ? [[gray, -1]] : null;
  if (!targets) throw fail('HDR_UNSUPPORTED', 'EXR channels: R G B or Y');
  if (alphaAt >= 0) targets.push([alphaAt, 3]);
  const used = targets.map(([c]) => c);
  if ([...used, ...(lumaChroma ? [ry, by] : [])].some(i => channels[i].kind === 0)) throw fail('HDR_UNSUPPORTED', 'EXR UINT color: unsupported');
  if (used.some(i => channels[i].xs !== 1 || channels[i].ys !== 1)) throw fail('HDR_UNSUPPORTED', 'EXR subsampled color: Y RY BY only');
  if (lumaChroma && [ry, by].some(i => channels[i].xs !== 2 || channels[i].ys !== 2)) throw fail('HDR_UNSUPPORTED', 'EXR RY/BY sampling: 2x2');
  const half = lumaChroma || used.every(i => channels[i].kind === 1);

  const chroma = attribute('chromaticities', 'chromaticities', 32, false);
  let look = {colorSpace: 'srgb'}, primaries = [0.64, 0.33, 0.3, 0.6, 0.15, 0.06, 0.3127, 0.329];
  if (chroma) {
    const vals = Array.from({length: 8}, (_, i) => dv.getFloat32(chroma.start + i * 4, true));
    if (vals.some(v => !Number.isFinite(v))) throw fail('HDR_MALFORMED', 'EXR chromaticities: finite');
    look = colour(vals, 1e-4);
    primaries = vals;
  }
  let intensityTarget;
  const white = attribute('whiteLuminance', 'float', 4, false);
  if (white) {
    const value = dv.getFloat32(white.start, true);
    if (!Number.isFinite(value) || value <= 0 || value > 1e6) throw fail('HDR_MALFORMED', 'EXR whiteLuminance: positive, at most 1,000,000 nits');
    intensityTarget = value;
  }

  const tiled = partTiled(attributes);
  const chunks = [];
  let firstDataByte;
  if (!tiled) {
    const rowsPerBlock = SCANLINES_PER_BLOCK[compression], count = Math.ceil(dataWin.height / rowsPerBlock);
    if (multipart && tableCounts[chosen] !== count) throw fail('HDR_MALFORMED', 'EXR chunkCount: scan-line count mismatch');
    firstDataByte = multipart ? allTablesEnd : tableStart + count * 8;
    if (firstDataByte > bytes.byteLength) throw fail('HDR_TRUNCATED', 'EXR scan-line offset table: incomplete');
    const seen = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const offset = Number(dv.getBigUint64(tableStart + i * 8, true));
      if (!Number.isSafeInteger(offset) || offset < firstDataByte || offset + partPrefix + 8 > bytes.byteLength) throw fail('HDR_MALFORMED', 'EXR scan-line offset: bounds');
      if (partPrefix && dv.getInt32(offset, true) !== partNumber) throw fail('HDR_MALFORMED', 'EXR scan-line part: mismatch');
      const y = dv.getInt32(offset + partPrefix, true), size = dv.getInt32(offset + partPrefix + 4, true), row = y - dataWin.minY;
      if (size < 0 || offset + partPrefix + 8 + size > bytes.byteLength || row < 0 || row >= dataWin.height || row % rowsPerBlock) throw fail('HDR_MALFORMED', 'EXR scan-line header: invalid');
      if (seen[row / rowsPerBlock]) throw fail('HDR_MALFORMED', 'EXR scan-line block: duplicate');
      seen[row / rowsPerBlock] = 1;
      chunks.push({offset, header: partPrefix + 8, size, x: dataWin.minX, y, width: dataWin.width, rows: Math.min(rowsPerBlock, dataWin.height - row)});
    }
  } else {
    const tiles = attribute('tiles', 'tiledesc', 9);
    const tileX = dv.getUint32(tiles.start, true), tileY = dv.getUint32(tiles.start + 4, true);
    const mode = bytes[tiles.start + 8], levelMode = mode & 15, roundUp = (mode >> 4) === 1;
    if (!tileX || !tileY || levelMode > 2 || (mode >> 4) > 1) throw fail('HDR_MALFORMED', 'EXR tiles: invalid description');
    const grid = (w, h) => Math.ceil(w / tileX) * Math.ceil(h / tileY);
    let total = 0;
    if (levelMode === 0) total = grid(dataWin.width, dataWin.height);
    else if (levelMode === 1) {
      for (let level = 0, n = levelCount(Math.max(dataWin.width, dataWin.height), roundUp); level < n; level++)
        total += grid(levelSize(dataWin.width, level, roundUp), levelSize(dataWin.height, level, roundUp));
    } else {
      for (let ly = 0, ny = levelCount(dataWin.height, roundUp); ly < ny; ly++)
        for (let lx = 0, nx = levelCount(dataWin.width, roundUp); lx < nx; lx++)
          total += grid(levelSize(dataWin.width, lx, roundUp), levelSize(dataWin.height, ly, roundUp));
    }
    if (total < 1) throw fail('HDR_MALFORMED', 'EXR tiles: empty');
    if (multipart && tableCounts[chosen] !== total) throw fail('HDR_MALFORMED', 'EXR chunkCount: tile count mismatch');
    firstDataByte = multipart ? allTablesEnd : tableStart + total * 8;
    if (firstDataByte > bytes.byteLength) throw fail('HDR_TRUNCATED', 'EXR tile offset table: incomplete');
    const nx0 = Math.ceil(dataWin.width / tileX), ny0 = Math.ceil(dataWin.height / tileY), seen = new Uint8Array(nx0 * ny0);
    let found = 0;
    for (let i = 0; i < total; i++) {
      const offset = Number(dv.getBigUint64(tableStart + i * 8, true));
      if (!Number.isSafeInteger(offset) || offset < firstDataByte || offset + partPrefix + 20 > bytes.byteLength) throw fail('HDR_MALFORMED', 'EXR tile offset: bounds');
      if (partPrefix && dv.getInt32(offset, true) !== partNumber) throw fail('HDR_MALFORMED', 'EXR tile part: mismatch');
      const dx = dv.getInt32(offset + partPrefix, true), dy = dv.getInt32(offset + partPrefix + 4, true), lx = dv.getInt32(offset + partPrefix + 8, true), ly = dv.getInt32(offset + partPrefix + 12, true), size = dv.getInt32(offset + partPrefix + 16, true);
      if (size < 0 || offset + partPrefix + 20 + size > bytes.byteLength || lx < 0 || ly < 0 || dx < 0 || dy < 0) throw fail('HDR_MALFORMED', 'EXR tile header: invalid');
      if (levelMode === 0 && (lx || ly) || levelMode === 1 && lx !== ly) throw fail('HDR_MALFORMED', 'EXR tile level: invalid');
      if (lx || ly) continue;
      if (dx >= nx0 || dy >= ny0 || seen[dy * nx0 + dx]) throw fail('HDR_MALFORMED', 'EXR tiles: bounds or duplicate');
      seen[dy * nx0 + dx] = 1; found++;
      const x = dataWin.minX + dx * tileX, y = dataWin.minY + dy * tileY;
      chunks.push({offset, header: partPrefix + 20, size, x, y, width: Math.min(tileX, dataWin.maxX - x + 1), rows: Math.min(tileY, dataWin.maxY - y + 1)});
    }
    if (found !== nx0 * ny0) throw fail('HDR_MALFORMED', 'EXR tiles: missing full level');
  }
  const physical = [...chunks].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < physical.length; i++) if (physical[i].offset < physical[i - 1].offset + physical[i - 1].header + physical[i - 1].size) throw fail('HDR_MALFORMED', 'EXR blocks: overlap');
  for (const chunk of chunks) {
    chunk.expected = blockBytes(chunk, channels);
    const made = compression === 5 ? blockBytes(chunk, channels, pxr24Bytes) : chunk.expected;
    if (chunk.size < chunk.expected && chunk.size * EXPANSION[compression] < made) throw fail('HDR_MALFORMED', 'EXR block: too short');
  }

  const one = half ? 0x3c00 : 0x3f800000;
  let out;
  const canvas = () => {
    if (out) return out;
    try { out = half ? new Uint16Array(outWin.width * outWin.height * 4) : new Uint32Array(outWin.width * outWin.height * 4); }
    catch (error) {
      if (!(error instanceof RangeError) || outOfMemory(error)) throw error;
      throw refuse('JXL_INPUT', `The OpenEXR ${outWin === dataWin ? 'data' : 'display'} window (${outWin.width} x ${outWin.height}) is larger than any picture this host can hold; read the data window or export a smaller picture.`);
    }
    if (alphaAt < 0) {
      const x0 = Math.max(outWin.minX, dataWin.minX) - outWin.minX, x1 = Math.min(outWin.maxX, dataWin.maxX) - outWin.minX;
      const y0 = Math.max(outWin.minY, dataWin.minY) - outWin.minY, y1 = Math.min(outWin.maxY, dataWin.maxY) - outWin.minY;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out[(y * outWin.width + x) * 4 + 3] = one;
    }
    return out;
  };
  const W = dataWin.width, H = dataWin.height;
  let lc = null;
  const planes = () => lc ??= {Y: new Uint16Array(W * H), RY: new Uint16Array(W * H / 4), BY: new Uint16Array(W * H / 4), A: new Uint16Array(W * H).fill(0x3c00)};
  const halfAt = (rv, channel, at) => channel.kind === 1 ? rv.getUint16(at, true) : floatToHalfBits(rv.getFloat32(at, true));
  const place = async chunk => {
    chunk.geo = layout(chunk, channels);
    const packed = bytes.subarray(chunk.offset + chunk.header, chunk.offset + chunk.header + chunk.size);
    const raw = await decompressBlock(packed, compression, chunk, channels);
    const x0 = Math.max(chunk.x, outWin.minX), x1 = Math.min(chunk.x + chunk.width - 1, outWin.maxX);
    const y0 = Math.max(chunk.y, outWin.minY), y1 = Math.min(chunk.y + chunk.rows - 1, outWin.maxY);
    if (!lumaChroma && (x0 > x1 || y0 > y1)) return;
    const out = lumaChroma ? null : canvas(), lc = lumaChroma ? planes() : null;
    const aligned = raw.byteOffset % 4 === 0 ? raw : raw.slice(), rv = new DataView(aligned.buffer, aligned.byteOffset, aligned.byteLength);
    const {rowAt, nx} = chunk.geo;
    if (lc) {
      for (let r = 0; r < chunk.rows; r++) {
        const y = chunk.y + r, line = (y - dataWin.minY) * W + (chunk.x - dataWin.minX);
        for (const [c, plane] of [[gray, lc.Y], [alphaAt, lc.A]]) {
          if (c < 0) continue;
          for (let i = 0, at = rowAt[r][c]; i < nx[c]; i++, at += channels[c].sampleBytes) plane[line + i] = halfAt(rv, channels[c], at);
        }
        for (const [c, plane] of [[ry, lc.RY], [by, lc.BY]]) {
          if (rowAt[r][c] < 0) continue;
          const first = keeps(chunk.x, 2) ? chunk.x : chunk.x + 1, base = Math.floor((y - dataWin.minY) / 2) * (W / 2) + Math.floor((first - dataWin.minX) / 2);
          for (let i = 0, at = rowAt[r][c]; i < nx[c]; i++, at += channels[c].sampleBytes) plane[base + i] = halfAt(rv, channels[c], at);
        }
      }
      return;
    }
    const v16 = new Uint16Array(aligned.buffer, aligned.byteOffset, Math.floor(aligned.byteLength / 2)), v32 = new Uint32Array(aligned.buffer, aligned.byteOffset, Math.floor(aligned.byteLength / 4));
    const count = x1 - x0 + 1;
    for (let y = y0; y <= y1; y++) {
      const row = ((y - outWin.minY) * outWin.width + (x0 - outWin.minX)) * 4;
      for (const [c, slot] of targets) {
        const channel = channels[c], from = rowAt[y - chunk.y][c] + (x0 - chunk.x) * channel.sampleBytes;
        const last = slot < 0 ? 3 : slot + 1;
        for (let k = slot < 0 ? 0 : slot; k < last; k++) {
          let dst = row + k;
          if (channel.kind === 1 && LITTLE) {
            if (half) for (let i = 0, at = from / 2; i < count; i++, dst += 4) out[dst] = v16[at + i];
            else for (let i = 0, at = from / 2; i < count; i++, dst += 4) out[dst] = halfBitsToFloat32Bits(v16[at + i]);
          } else if (channel.kind === 2 && LITTLE && (from & 3) === 0) {
            for (let i = 0, at = from / 4; i < count; i++, dst += 4) out[dst] = v32[at + i];
          } else for (let i = 0; i < count; i++, dst += 4) out[dst] = channel.kind === 1 ? (half ? rv.getUint16(from + i * 2, true) : halfBitsToFloat32Bits(rv.getUint16(from + i * 2, true))) : rv.getUint32(from + i * 4, true);
        }
      }
    }
  };
  for (let i = 0; i < chunks.length;) {
    let j = i, held = 0;
    while (j < chunks.length && j - i < 8 && (j === i || held + chunks[j].expected <= 67_108_864)) held += chunks[j++].expected;
    await Promise.all(chunks.slice(i, j).map(place));
    i = j;
  }
  canvas();
  if (lumaChroma) {
    const lc = planes(), rgba = lumaChromaToRgba(lc.Y, lc.RY, lc.BY, lc.A, W, H, dataWin.minY, luminanceWeights(primaries));
    const xa = Math.max(outWin.minX, dataWin.minX), xb = Math.min(outWin.maxX, dataWin.maxX);
    for (let y = Math.max(outWin.minY, dataWin.minY); y <= Math.min(outWin.maxY, dataWin.maxY); y++) for (let x = xa; x <= xb; x++)
      out.set(rgba.subarray(((y - dataWin.minY) * W + x - dataWin.minX) * 4, ((y - dataWin.minY) * W + x - dataWin.minX) * 4 + 4), ((y - outWin.minY) * outWin.width + x - outWin.minX) * 4);
  }
  let opaque = true;
  for (let i = 3; i < out.length && opaque; i += 4) opaque = out[i] === one;
  return {data: half ? out : new Float32Array(out.buffer), width: outWin.width, height: outWin.height, bitDepth: half ? 16 : 32,
    sampleFormat: half ? 'float16' : 'float32', ...look, transferFunction: 'linear', alphaPremultiplied: alphaAt >= 0 && !opaque,
    ...(intensityTarget !== undefined && {intensityTarget}), ...(partCount > 1 && {parts: partCount})};
}

const RADIANCE_DEFAULT = [0.64, 0.33, 0.29, 0.60, 0.15, 0.06, 1 / 3, 1 / 3];
function radianceColour(primaries) {
  if (!primaries || primaries.every(v => v === 0) || near(primaries, RADIANCE_DEFAULT, 1.5e-3)) return {colorSpace: 'srgb'};
  for (let i = 0; i < 8; i += 2) {
    const x = primaries[i], y = primaries[i + 1];
    if (x <= 0 || y <= 0 || x + y > 1.0001) throw fail('HDR_MALFORMED', 'PRIMARIES: outside CIE xy');
  }
  return colour(primaries, 1.5e-3);
}

function readRadianceBytes(bytes, maxPixels) {
  const hdr = parseHeader(bytes);
  const {scanCount, scanWidth, axis1, axis2, format} = hdr;
  if (format !== '32-bit_rle_rgbe') throw fail('HDR_UNSUPPORTED', 'Radiance FORMAT: XYZE unsupported');
  if (axis1[1] !== 'Y' || axis2[1] !== 'X') throw fail('HDR_UNSUPPORTED', `Radiance orientation ${axis1} ${scanCount} ${axis2} ${scanWidth}: Y rows X columns`);
  const flipY = axis1[0] === '+', flipX = axis2[0] === '-';
  const width = scanWidth, height = scanCount;
  if (maxPixels !== undefined && width * height > maxPixels) throw fail('HDR_DIMENSIONS', `Radiance: exceeds maxPixels ${maxPixels}`);
  const rowBytes = scanWidth >= 8 && scanWidth <= 0x7fff ? Math.min(4 * scanWidth, 4 + 8 * Math.ceil(scanWidth / 127)) : 4 * scanWidth;
  if (bytes.length - hdr.dataStart < scanCount * rowBytes) throw fail('HDR_TRUNCATED', 'Radiance picture: incomplete');
  const look = radianceColour(hdr.primaries);
  const rgbe = decodeScanlines(bytes, hdr.dataStart, scanWidth, scanCount);
  const out = new Float32Array(width * height * 4);
  for (let s = 0; s < scanCount; s++) {
    const outRow = flipY ? scanCount - 1 - s : s;
    for (let x = 0; x < scanWidth; x++) {
      const src = (s * scanWidth + x) * 4, dst = (outRow * scanWidth + (flipX ? scanWidth - 1 - x : x)) * 4, e = rgbe[src + 3];
      out[dst + 3] = 1;
      if (!e) continue;
      const scale = EXP_SCALE[e];
      for (let c = 0; c < 3; c++) {
        out[dst + c] = rgbe[src + c] * scale;
      }
    }
  }
  let data = out, sampleFormat = 'float32', bitDepth = 32;
  const bits = new Uint32Array(out.buffer), halves = new Uint16Array(out.length);
  let exact = true;
  for (let i = 0; i < bits.length && exact; i++) { const half = floatBitsToHalfBits(bits[i]); if (half < 0) exact = false; else halves[i] = half; }
  if (exact) { data = halves; sampleFormat = 'float16'; bitDepth = 16; }
  return {data, width, height, bitDepth, sampleFormat, ...look, transferFunction: 'linear', alphaPremultiplied: false};
}

function floatBitsToHalfBits(bits) {
  const sign = (bits >>> 16) & 0x8000, exponent = (bits >>> 23) & 255, fraction = bits & 0x7fffff;
  if (exponent === 0 && fraction === 0) return sign;
  if (exponent >= 113 && exponent <= 142) return fraction & 0x1fff ? -1 : sign | ((exponent - 112) << 10) | (fraction >>> 13);
  if (exponent >= 103 && exponent < 113) {
    const shift = 126 - exponent, value = fraction | 0x800000;
    return value & ((1 << shift) - 1) ? -1 : sign | (value >>> shift);
  }
  return -1;
}

const ascii = (b, a, e) => { let t = ''; for (let i = a; i < Math.min(e, b.length); i++) t += String.fromCharCode(b[i]); return t; };
const isRadianceHeader = b => /^(#\?RADIANCE|#\?RGBE|FORMAT=32-bit_rle_(rgbe|xyze))/.test(ascii(b, 0, 24));

export async function read(input, options = {}) {
  const settings = snapshotOptions(options);
  for (const key of Object.keys(settings)) if (key !== 'window' && key !== 'maxPixels')
    throw refuse('JXL_OPTIONS', `unknown option: ${key}`);
  const {window = 'data', maxPixels} = settings;
  if (window !== 'data' && window !== 'display') throw refuse('JXL_OPTIONS', "window: data or display");
  if (maxPixels !== undefined && (!Number.isSafeInteger(maxPixels) || maxPixels < 1))
    throw refuse('JXL_OPTIONS', "maxPixels: positive safe integer");
  let bytes;
  if (isBlob(input)) bytes = await blobBytes(input);
  else {
    if (arrayBufferBytes(input) !== null) {
      try { input = new Uint8Array(input); }
      catch { throw refuse('JXL_INPUT', "ArrayBuffer: detached"); }
    }
    bytes = copyBytes(input);
  }
  try {
    if (bytes.length >= 4 && new DataView(bytes.buffer).getUint32(0, true) === EXR_MAGIC) return await readExr(bytes, window, maxPixels);
    if (isRadianceHeader(bytes)) return readRadianceBytes(bytes, maxPixels);
    throw fail('HDR_FORMAT', 'not OpenEXR (.exr) or Radiance (.hdr)');
  } catch (error) { throw declared(error); }
}
