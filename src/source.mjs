// SPDX-License-Identifier: MIT
import {outOfMemory, hostWords} from './fault.mjs';
import {fault} from './admit.mjs';
import {inspectICC} from './color-info.mjs';
import {exifOrientation} from './exif-orientation.mjs';
import {prepareKernels, ensureKernels, pngRow} from './kernels.mjs';
import {wasmRequired} from './capture-wasm-error.mjs';
import {PNG_CHANNELS, pngWalk, pngColourStatement, inflate} from './png-chunks.mjs';

const refuse = message => { throw fault('JXL_INPUT', message); };
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
async function pngColour(chunks, colourType) {
  const statement = pngColourStatement(chunks, colourType);
  if (!statement.packed) return statement;
  const space = colourType === 0 || colourType === 4 ? 'gray' : 'rgb';
  const icc = await inflate([statement.packed]), channels = inspectICC(icc, undefined, space);
  if (channels !== (space === 'gray' ? 1 : 3)) refuse('PNG: ICC channel mismatch');
  return {icc};
}

const pngPasses = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
  [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
export function unfilterRow(filter, raw, at, row, previous, n, bpp) {
  pngRow(row, n, previous, raw, at, filter, bpp);
}
export async function pngRowKernels() {
  if (!await prepareKernels() || !ensureKernels()) throw wasmRequired();
}

export function pngOrientationLocation({chunks, exifAt}) {
  const header = view(chunks.get('IHDR')), exif = chunks.get('eXIf');
  let orientationAt, orientationBig;
  const orientation = exif ? exifOrientation(exif,0,exif.length,(at,big) => { orientationAt = exifAt + at; orientationBig = big; }) : null;
  return {width:header.getUint32(0),height:header.getUint32(4),orientation:orientation ?? 1,orientationAt,orientationBig,
    ...(orientationAt !== undefined && {exifAt,exifLength:exif.length})};
}

export async function pngLayout({chunks, parts, ended}) {
  if (!ended) refuse('PNG: truncated');
  const header = chunks.get('IHDR'), width = view(header).getUint32(0), height = view(header).getUint32(4), depth = header[8],
    colourType = header[9], channels = PNG_CHANNELS[colourType], interlace = header[12];
  const palette = chunks.get('PLTE');
  if (colourType === 3 && !palette) refuse('palette PNG: missing PLTE');
  const colour = await pngColour(chunks, colourType);
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

export async function pngStructure(bytes, maxPixels) {
  const layout = await pngLayout(pngWalk(null, bytes, 0, bytes.length, maxPixels));
  return {...layout, packed: layout.parts.map(([at, length]) => bytes.subarray(at, at + length))};
}
export function pngRows({width, depth, colourType, channels, palette, paletteAlpha, transparent}, result, row0 = 0) {
  const wide = depth === 16, full = wide ? 65535 : 255, entries = palette ? palette.length / 3 : 0, scale = wide || depth === 8 ? 1 : 255 / ((1 << depth) - 1);
  const plainDepth = !wide && depth === 8 && colourType !== 3 && !transparent;
  return (row, w, startX, startY, dx, dy, y) => {
    if (plainDepth && dx === 1) {
      const at = (startY + y * dy - row0) * width * 4;
      if (channels === 4) result.set(row.subarray(0, w * 4), at);
      else pngRow(row, w * channels, null, null, 0, 0, 0, result, at, w, channels);
      return;
    }
    const samples = view(row);
    const sample = wide ? n => samples.getUint16(n * 2) : depth === 8 ? n => row[n] : n => (row[(n * depth) >> 3] >> (8 - depth - ((n * depth) & 7))) & ((1 << depth) - 1);
    for (let x = 0; x < w; x++) {
      const dst = ((startY + y * dy - row0) * width + startX + x * dx) * 4;
      if (colourType === 3) {
        const index = sample(x);
        if (index >= entries) refuse('palette index: out of range');
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

async function png(bytes, maxPixels) {
  await pngRowKernels();
  const structure = await pngStructure(bytes, maxPixels), {width, height, depth, channels, expected, packed, colour, orientation} = structure;
  const raw = await inflate(packed, expected), wide = depth === 16, bytesPerPixel = Math.max(1, (channels * depth) >> 3);
  const result = wide ? new Uint16Array(width * height * 4) : new Uint8Array(width * height * 4), write = pngRows(structure, result);
  let cursor = 0;
  for (const [startX, startY, dx, dy, w, h, rowBytes] of pngPassRows(structure)) {
    let previous = new Uint8Array(rowBytes), row = new Uint8Array(rowBytes);
    for (let y = 0; y < h; y++) {
      const filter = raw[cursor++];
      if (filter > 4) refuse('PNG row filter: invalid (expected 0-4)');
      unfilterRow(filter, raw, cursor, row, previous, rowBytes, bytesPerPixel);
      cursor += rowBytes;
      write(row, w, startX, startY, dx, dy, y);
      [previous, row] = [row, previous];
    }
  }
  return {data: result, width, height, bitDepth: wide ? 16 : 8, sampleFormat: 'uint', ...colour, alphaPremultiplied: false, ...(orientation > 1 && {orientation})};
}

async function read(input, reader) {
  try {
    if (!(input instanceof Uint8Array) && !(input instanceof ArrayBuffer) || input.byteLength === 0) refuse('input: nonempty Uint8Array or ArrayBuffer');
    const bytes = input instanceof ArrayBuffer ? new Uint8Array(input.slice(0)) : new Uint8Array(input);
    return await reader(bytes);
  } catch (error) {
    if (outOfMemory(error)) throw Object.assign(fault('JXL_MEMORY', `out of memory${hostWords(error)}`), {cause: error});
    throw error;
  }
}
const isPNG = bytes => bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value);
export function readSource(input, {maxPixels} = {}) {
  return read(input, bytes => {
    if (isPNG(bytes)) return png(bytes, maxPixels);
    refuse('not PNG: use jpegxl/hdr for EXR or HDR');
  });
}
export function readPNG16(input, {maxPixels} = {}) {
  return read(input, bytes => { if (isPNG(bytes)) return png(bytes, maxPixels); refuse('not PNG'); });
}
