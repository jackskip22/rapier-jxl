#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Reproducible inputs for rate/distortion and encode-cost measurements. No encoder is used to prepare pixels.
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {deflateSync, inflateSync} from 'node:zlib';
import {readPng, sha256, writePng} from './image-io.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Uint32Array.from({length: 256}, (_, value) => {
  for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function chunk(name, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length); out.write(name, 4); Buffer.from(data).copy(out, 8);
  let crc = 0xffffffff;
  for (const byte of out.subarray(4, -4)) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
  return out;
}

// Only the pinned HDR fixture needs this path: noninterlaced 16-bit RGB/RGBA PNG. Refuse other layouts.
// Keep the stored integer samples and original color declarations; never round them through RGBA8 or a canvas.
function readPng16(bytes) {
  const png = Buffer.from(bytes), parts = [], colorChunks = [];
  if (!png.subarray(0, 8).equals(signature)) throw new Error('Not a PNG');
  let width, height, channels;
  for (let at = 8; at + 12 <= png.length;) {
    const length = png.readUInt32BE(at), end = at + length + 12;
    if (end > png.length) throw new Error('Truncated PNG');
    const name = png.toString('ascii', at + 4, at + 8), data = png.subarray(at + 8, end - 4);
    if (name === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      channels = data[9] === 2 ? 3 : data[9] === 6 ? 4 : 0;
      if (data[8] !== 16 || !channels || data[10] || data[11] || data[12]) throw new Error('Expected noninterlaced 16-bit RGB/RGBA PNG');
    } else if (name === 'IDAT') parts.push(data);
    else if (['iCCP', 'cICP', 'cHRM', 'gAMA', 'sRGB'].includes(name)) colorChunks.push(png.subarray(at, end));
    else if (name === 'IEND') break;
    at = end;
  }
  const stride = width * channels * 2, raw = inflateSync(Buffer.concat(parts));
  if (raw.length !== height * (stride + 1)) throw new Error('HDR PNG extent mismatch');
  const rgba = new Uint16Array(width * height * 4);
  let previous = Buffer.alloc(stride), row = Buffer.alloc(stride), at = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[at++];
    if (filter > 4) throw new Error('Invalid PNG filter');
    for (let x = 0; x < stride; x++) {
      const a = x >= channels * 2 ? row[x - channels * 2] : 0, b = previous[x];
      const c = x >= channels * 2 ? previous[x - channels * 2] : 0, p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0;
      row[x] = raw[at++] + predictor;
    }
    for (let x = 0; x < width; x++) {
      const source = x * channels * 2, dest = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) rgba[dest + c] = row.readUInt16BE(source + c * 2);
      rgba[dest + 3] = channels === 4 ? row.readUInt16BE(source + 6) : 65535;
    }
    [row, previous] = [previous, row];
  }
  return {width, height, rgba, colorChunks};
}

function writePng16({width, height, rgba, colorChunks}) {
  const stride = width * 8, raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1); raw[at] = 0;
    for (let x = 0; x < width * 4; x++) raw.writeUInt16BE(rgba[y * width * 4 + x], at + 1 + x * 2);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 16; header[9] = 6;
  return Buffer.concat([signature, chunk('IHDR', header), ...colorChunks, chunk('IDAT', deflateSync(raw, {level: 3})), chunk('IEND', Buffer.alloc(0))]);
}

export function readIdealPng(bytes) {
  return bytes[24] === 16 ? readPng16(bytes) : readPng(bytes);
}

function rawPixels(image, bitDepth) {
  if (bitDepth === 8) return Buffer.from(image.rgba);
  const out = Buffer.alloc(image.rgba.length * 2);
  for (let i = 0; i < image.rgba.length; i++) out.writeUInt16LE(image.rgba[i], i * 2);
  return out;
}

function cropImage(image, crop) {
  const {x, y, width, height} = crop;
  if (![x, y, width, height].every(Number.isInteger) || x < 0 || y < 0 || width < 1 || height < 1 || x + width > image.width || y + height > image.height)
    throw new Error('Invalid crop');
  const rgba = new image.rgba.constructor(width * height * 4);
  for (let row = 0; row < height; row++) {
    const start = ((y + row) * image.width + x) * 4;
    rgba.set(image.rgba.subarray(start, start + width * 4), row * width * 4);
  }
  return {...image, width, height, rgba};
}

async function sourceBytes(item, dir, offline) {
  const file = join(dir, 'downloads', item.sha256 + '.png');
  if (existsSync(file)) {
    const bytes = readFileSync(file);
    if (sha256(bytes) !== item.sha256) throw new Error('Cached source hash mismatch: ' + item.id);
    return bytes;
  }
  if (offline) throw new Error('Missing cached source: ' + item.id);
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(item.url, {signal: AbortSignal.timeout(60000), headers: {'user-agent': 'rapier-jxl-bench/1.0 (corpus fetch)'}});
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (sha256(bytes) !== item.sha256) throw new Error('Downloaded source hash mismatch: ' + item.id);
      writeFileSync(file, bytes); return bytes;
    } catch (error) { last = error; }
  }
  throw new Error('Cannot fetch ' + item.id + ': ' + last.message);
}

export async function buildIdealCorpus({dir, sources = join(here, 'ideal-corpus-sources.json'), ids, offline = false}) {
  dir = resolve(dir);
  const document = JSON.parse(readFileSync(sources, 'utf8')), manifest = [];
  const wanted = ids ? new Set(ids) : null, selected = document.images.filter(item => !wanted || wanted.has(item.id));
  if (wanted && selected.length !== wanted.size) throw new Error('Unknown or duplicate corpus IDs');
  for (const subdir of ['downloads', 'pixels', 'png']) mkdirSync(join(dir, subdir), {recursive: true});
  for (const item of selected) {
    const bytes = await sourceBytes(item, dir, offline);
    let image = item.bitDepth === 16 ? readPng16(bytes) : readPng(bytes);
    if (item.crop) image = cropImage(image, item.crop);
    if (image.width !== item.width || image.height !== item.height) throw new Error('Dimensions differ: ' + item.id);
    const raw = rawPixels(image, item.bitDepth), actual = sha256(raw);
    if (actual !== item.rgbaHash) throw new Error('Prepared pixels differ: ' + item.id + ' ' + actual);
    const pixels = 'pixels/' + item.id + (item.bitDepth === 16 ? '.rgba16le' : '.rgba');
    const png = 'png/' + item.id + '.png';
    writeFileSync(join(dir, pixels), raw);
    writeFileSync(join(dir, png), item.bitDepth === 16 ? writePng16(image) : writePng(image.width, image.height, image.rgba));
    manifest.push({id: item.id, kind: item.group, group: item.group, width: item.width, height: item.height,
      bitDepth: item.bitDepth, channels: 4, sampleFormat: 'uint', colorSpace: item.colorSpace,
      transferFunction: item.transferFunction, intensityTarget: item.intensityTarget, alphaPremultiplied: false,
      pixels, png, rgbaHash: actual, source: item.url, sourceSha256: item.sha256,
      license: item.license, provenance: item.provenance, ...(item.crop ? {crop: item.crop, derivedFrom: item.derivedFrom} : {})});
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const options = {};
  for (let i = 2; i < process.argv.length; i++) {
    const name = process.argv[i];
    if (name === '--dir') options.dir = process.argv[++i];
    else if (name === '--ids') options.ids = process.argv[++i].split(',');
    else if (name === '--sources') options.sources = resolve(process.argv[++i]);
    else if (name === '--offline') options.offline = true;
    else throw new Error('Unknown argument: ' + name);
  }
  if (!options.dir) throw new Error('Use --dir DIRECTORY [--ids ID,ID] [--offline]');
  const rows = await buildIdealCorpus(options);
  console.log(rows.length + ' images; ' + rows.reduce((sum, row) => sum + row.width * row.height, 0) + ' pixels; ' + resolve(options.dir, 'manifest.json'));
}
