// SPDX-License-Identifier: MIT
// PNG reading and writing for the benchmark corpus. Pixels are straight RGBA, 8 bits per sample. The reader accepts
// every 8-bit-or-less PNG layout, including palettes with tRNS and Adam7 interlacing; it refuses 16-bit input.
import {createHash} from 'node:crypto';
import {deflateSync, inflateSync} from 'node:zlib';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4};
const PASSES = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

// Undo the per-row filters of one (sub)image in place; returns the unfiltered rows, packed.
function unfilter(raw, at, rows, rowBytes, bpp) {
  const out = new Uint8Array(rows * rowBytes);
  for (let y = 0; y < rows; y++) {
    const filter = raw[at++], dst = y * rowBytes, up = dst - rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const x = raw[at + i], a = i >= bpp ? out[dst + i - bpp] : 0, b = y ? out[up + i] : 0, c = y && i >= bpp ? out[up + i - bpp] : 0;
      out[dst + i] = (filter === 0 ? x : filter === 1 ? x + a : filter === 2 ? x + b : filter === 3 ? x + ((a + b) >> 1) : x + paeth(a, b, c)) & 255;
    }
    at += rowBytes;
  }
  return {out, at};
}

// Decode a PNG file to {width, height, rgba}. Samples are not colour managed: they are the stored values.
export function readPng(file) {
  const png = Buffer.from(file);
  if (png.length < 33 || !png.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG file');
  let header, palette, transparency; const idat = [];
  for (let at = 8; at + 12 <= png.length;) {
    const length = png.readUInt32BE(at), tag = png.toString('latin1', at + 4, at + 8), body = png.subarray(at + 8, at + 8 + length);
    if (tag === 'IHDR') header = {width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colour: body[9], interlace: body[12]};
    else if (tag === 'PLTE') palette = body;
    else if (tag === 'tRNS') transparency = body;
    else if (tag === 'IDAT') idat.push(body);
    else if (tag === 'IEND') break;
    at += 12 + length;
  }
  if (!header) throw new Error('PNG has no header');
  const {width, height, depth, colour, interlace} = header, channels = CHANNELS[colour];
  if (!channels || depth > 8) throw new Error('Unsupported PNG layout: colour type ' + colour + ', depth ' + depth);
  const raw = inflateSync(Buffer.concat(idat)), bitsPerPixel = channels * depth, bpp = Math.max(1, bitsPerPixel >> 3);
  const rgba = new Uint8Array(width * height * 4), scale = depth < 8 && colour !== 3 ? 255 / ((1 << depth) - 1) : 1;
  const sample = (row, index) => {  // sample `index` of a packed row
    if (depth === 8) return row[index];
    const bit = index * depth;
    return (row[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
  };
  const place = (row, w, y, x0, dx, py) => {
    for (let k = 0; k < w; k++) {
      const x = x0 + k * dx, o = (py(y) * width + x) * 4;
      let r, g, b, a = 255;
      if (colour === 3) {
        const p = sample(row, k); r = palette[p * 3]; g = palette[p * 3 + 1]; b = palette[p * 3 + 2]; a = transparency && p < transparency.length ? transparency[p] : 255;
      } else if (colour === 0) {
        r = g = b = Math.round(sample(row, k) * scale);
        if (transparency && transparency.length >= 2 && sample(row, k) === transparency.readUInt16BE(0)) a = 0;
      } else if (colour === 4) { r = g = b = row[k * 2]; a = row[k * 2 + 1]; }
      else if (colour === 2) {
        r = row[k * 3]; g = row[k * 3 + 1]; b = row[k * 3 + 2];
        if (transparency && transparency.length >= 6 && r === transparency[1] && g === transparency[3] && b === transparency[5]) a = 0;
      } else { r = row[k * 4]; g = row[k * 4 + 1]; b = row[k * 4 + 2]; a = row[k * 4 + 3]; }
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
    }
  };
  if (!interlace) {
    const rowBytes = Math.ceil(width * bitsPerPixel / 8), {out} = unfilter(raw, 0, height, rowBytes, bpp);
    for (let y = 0; y < height; y++) place(out.subarray(y * rowBytes, (y + 1) * rowBytes), width, y, 0, 1, v => v);
  } else {
    let at = 0;
    for (const [x0, y0, dx, dy] of PASSES) {
      const w = Math.ceil((width - x0) / dx), h = Math.ceil((height - y0) / dy);
      if (w <= 0 || h <= 0) continue;
      const rowBytes = Math.ceil(w * bitsPerPixel / 8), result = unfilter(raw, at, h, rowBytes, bpp);
      at = result.at;
      for (let y = 0; y < h; y++) place(result.out.subarray(y * rowBytes, (y + 1) * rowBytes), w, y, x0, dx, v => y0 + v * dy);
    }
  }
  return {width, height, rgba};
}

const crcTable = Int32Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = bytes => { let c = -1; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (tag, body) => {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0); out.write(tag, 4, 'latin1'); Buffer.from(body).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
};

// Encode straight RGBA as a PNG with no colour chunks (readers treat the samples as sRGB). Filter 1 keeps files small
// enough to move quickly; the compressed size does not matter to any measurement.
export function writePng(width, height, rgba) {
  const stride = width * 4, raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1), row = y * stride;
    raw[at] = 1;
    for (let i = 0; i < stride; i++) raw[at + 1 + i] = (rgba[row + i] - (i >= 4 ? rgba[row + i - 4] : 0)) & 255;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, {level: 3})), chunk('IEND', Buffer.alloc(0))]);
}

// Shape facts about straight RGBA: how many colours, which alpha values, and whether hidden colour exists.
export function describe(width, height, rgba) {
  const colours = new Set(); let minAlpha = 255, partial = 0, hidden = 0;
  for (let i = 0; i < width * height * 4; i += 4) {
    if (colours.size <= 65536) colours.add((rgba[i] << 24 | rgba[i + 1] << 16 | rgba[i + 2] << 8 | rgba[i + 3]) >>> 0);
    const a = rgba[i + 3];
    if (a < minAlpha) minAlpha = a;
    if (a > 0 && a < 255) partial++;
    if (a === 0 && (rgba[i] | rgba[i + 1] | rgba[i + 2])) hidden++;
  }
  return {colours: colours.size > 65536 ? '>65536' : colours.size, alpha: minAlpha === 255 ? 'opaque' : partial ? 'soft' : 'binary', hiddenRgbPixels: hidden};
}
