#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import './cli-floor.mjs';
import {readFile, writeFile, stat, readdir, mkdir, mkdtemp, link, rm, realpath, open} from 'node:fs/promises';
import {basename, dirname, extname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {deflateSync} from 'node:zlib';
import {fail, declared, dimensions, PIXELS} from './primitives.mjs';
import {readGifBytes} from './gif-source.mjs';
import {imageResult, resultJSON} from './result.mjs';
import {readPNG16} from '../source.mjs';
import {orientSamples} from '../sample-transforms.mjs';
import {jpegInfo} from './input-native.mjs';
import {JPEG_SOURCE, jpegChoiceMode, jpegWins} from './jpeg-choice-policy.mjs';
import {COMMAND} from './package-name.mjs';
import {belowFloor, FLOOR} from './node-floor.mjs';
import {cliError, cliArgs} from './cli-error.mjs';
import {isPlainRecord} from './records.mjs';
import {typedFields, typedName} from './bytes.mjs';
export {readGifBytes} from './gif-source.mjs';
import {ownName} from './package-name.mjs';

const VERSION = typeof __RAPIER_JXL_VERSION__ !== 'undefined' ? __RAPIER_JXL_VERSION__ : '0.0.0-source';

export const HELP_TEXT = `Usage: ${COMMAND} <file|folder...> [options]
       ${COMMAND} add emdash | wordpress | payload | astro | vite | webpack | next | netlify | void | workers | r2 | agents | apache | nginx | caddy | android | ios | flutter | expo | capacitor | electron | tauri
       ${COMMAND} add                 lists every place, one line each
       ${COMMAND} remove <integration>
       ${COMMAND} site <folder> [--dry-run]
       ${COMMAND} selftest
       ${COMMAND} verify <original|folder> <file.jxl|folder>

Encode images to JPEG XL (.jxl), or restore recompressed JPEGs.
JPEGs are recompressed losslessly by default and restore exactly.

Options:
  -q, --quality <1-100>    Target quality (default 90, and a JPEG without it stays exact)
  -e, --effort <1-10>      Encoding effort, 1 fastest, 10 slowest (default: 7)
      --max-bytes <size>   Fit output under byte budget (e.g. 80KB, 1.5MB, 120000)
      --exact              Every pixel kept (default for JPEG)
      --jpeg-pixels        Re-encode JPEG pixels, retaining no JPEG reconstruction
  -o, --out <path>         Output file or directory
      --keep-extension     Keep the source extension in automatic .jxl names
  -j, --jobs <count>       Nonnegative helper count (default: 0)
      --verify             Verify each output before writing it
      --json               One JSON line per file, then a summary
  -h, --help               Show this help
  -v, --version            Show version

Examples:
  npx ${COMMAND} add emdash
  npx ${COMMAND} selftest
  npx ${COMMAND} photo.png
  npx ${COMMAND} photo.jpg
  npx ${COMMAND} scene.exr
  npx ${COMMAND} photos/ --effort 6 --jobs 4
  npx ${COMMAND} hero.png --quality 82 --out dist/hero.jxl
  npx ${COMMAND} banner.png --max-bytes 100KB
  npx ${COMMAND} photo.jxl --out restored.jpg
  npx ${COMMAND} verify photos/ out/
`;

const withoutBytes = ({bytes, byteEncoding, ...record}) => record;
export function parseByteSize(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number')
    throw cliError('JXL_OPTIONS', 'byte size: positive', 'size: 100KB');
  const text = String(raw ?? '').trim();
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|k|kib|mb|m|mib)?$/i.exec(text);
  if (!match) {
    throw cliError('JXL_OPTIONS', `--max-bytes "${raw}": positive size`,
      `run: npx ${COMMAND} photo.png --max-bytes 100KB`);
  }
  const value = Number(match[1]);
  const unit = (match[2] || 'b').toLowerCase();
  const scale = unit === 'k' || unit === 'kb' ? 1000
    : unit === 'kib' ? 1024
    : unit === 'm' || unit === 'mb' ? 1000000
    : unit === 'mib' ? 1048576
    : 1;
  const bytes = value * scale;
  if (!Number.isSafeInteger(bytes) || bytes < 1) {
    throw cliError('JXL_OPTIONS', `--max-bytes "${raw}": positive integer`,
      `run: npx ${COMMAND} photo.png --max-bytes 50KB`);
  }
  return bytes;
}

export function formatBytes(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0)
    throw cliError('JXL_INPUT', 'byte count: nonnegative safe integer', 'use: nonnegative safe integer');
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1000000).toFixed(2)} MB`;
}

export function parseCliArgs(argv) {
  argv = cliArgs(argv);
  const inputs = [];
  const options = {
    help: false,
    version: false,
    quality: undefined,
    effort: 7,
    effortExplicit: false,
    maxBytes: undefined,
    exact: false,
    jpegPixels: false,
    out: undefined,
    keepExtension: false,
    jobs: 0,
    verify: false,
    json: false,
  };
  let positionalOnly = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i]);
    if (positionalOnly || !arg.startsWith('-') || arg === '-') {
      inputs.push(arg);
      continue;
    }
    if (arg === '--') {
      positionalOnly = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;
    const inlineValue = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const takeValue = (name, example) => {
      if (inlineValue !== undefined) {
        if (inlineValue === '') throw cliError('JXL_OPTIONS', `${name}: value required`, `run: ${example}`);
        return inlineValue;
      }
      if (i + 1 >= argv.length) throw cliError('JXL_OPTIONS', `${name}: value required`, `run: ${example}`);
      if (String(argv[i + 1]).startsWith('-'))
        throw cliError('JXL_OPTIONS', name === '--out' ? `${name}: value "${argv[i + 1]}" needs =` : `${name}: value required`, name === '--out'
          ? `use: ${name}=${argv[i + 1]} or ./${argv[i + 1]}` : `run: ${example}`);
      return String(argv[++i]);
    };

    if (flag === '-h' || flag === '--help') {
      options.help = true;
    } else if (flag === '-v' || flag === '--version') {
      options.version = true;
    } else if (flag === '--json') {
      if (inlineValue !== undefined) throw cliError('JXL_OPTIONS', `--json: no value "${arg}"`, 'use: --json');
      options.json = true;
    } else if (flag === '--verify') {
      if (inlineValue !== undefined) throw cliError('JXL_OPTIONS', `--verify: no value "${arg}"`, 'use: --verify');
      options.verify = true;
    } else if (flag === '--exact') {
      if (inlineValue !== undefined) throw cliError('JXL_OPTIONS', `--exact: no value "${arg}"`, 'use: --exact');
      options.exact = true;
    } else if (flag === '--jpeg-pixels') {
      if (inlineValue !== undefined) throw cliError('JXL_OPTIONS', `--jpeg-pixels: no value "${arg}"`, 'use: --jpeg-pixels');
      options.jpegPixels = true;
    } else if (flag === '-q' || flag === '--quality') {
      const val = takeValue('--quality', `npx ${COMMAND} photo.png --quality 85`);
      const num = Number(val);
      if (!Number.isFinite(num) || num < 1 || num > 100) {
        throw cliError('JXL_OPTIONS', `--quality "${val}": number 1-100`,
          `run: npx ${COMMAND} photo.png --quality 85`);
      }
      options.quality = num;
    } else if (flag === '-e' || flag === '--effort') {
      const val = takeValue('--effort', `npx ${COMMAND} photo.png --effort 7`);
      const num = Number(val);
      if (!Number.isInteger(num) || num < 1 || num > 10) {
        throw cliError('JXL_OPTIONS', `--effort "${val}": integer 1-10`,
          `run: npx ${COMMAND} photo.png --effort 6`);
      }
      options.effort = num;
      options.effortExplicit = true;
    } else if (flag === '--max-bytes') {
      const val = takeValue('--max-bytes', `npx ${COMMAND} photo.png --max-bytes 100KB`);
      options.maxBytes = parseByteSize(val);
    } else if (flag === '-o' || flag === '--out') {
      options.out = takeValue('--out', `npx ${COMMAND} photo.png --out dist/photo.jxl`);
    } else if (flag === '--keep-extension') {
      if (inlineValue !== undefined) throw cliError('JXL_OPTIONS', `--keep-extension: no value "${arg}"`, 'use: --keep-extension');
      options.keepExtension = true;
    } else if (flag === '-j' || flag === '--jobs') {
      const val = takeValue('--jobs', `npx ${COMMAND} photos/ --jobs 4`);
      const num = Number(val);
      if (!Number.isInteger(num) || num < 0) {
        throw cliError('JXL_OPTIONS', `--jobs "${val}": integer >=0`,
          `run: npx ${COMMAND} photos/ --jobs 4`);
      }
      options.jobs = num;
    } else if ((typeof __RAPIER_JXL_TEACH__ === 'undefined' || __RAPIER_JXL_TEACH__ === true) && flag === '--teach') {
      options.teach = takeValue('--teach', `npx ${COMMAND} photo.png --effort 9 --teach taught.jsonl`);
    } else {
      throw cliError('JXL_OPTIONS', `unknown option: "${flag}"`,
        `run: npx ${COMMAND} --help`);
    }
  }

  if (options.exact && options.quality !== undefined && options.quality < 100) {
    throw cliError('JXL_OPTIONS', `--exact: not with --quality ${options.quality}`,
      `remove: --exact or --quality ${options.quality}`);
  }
  if (options.effort === 10 && options.maxBytes !== undefined)
    throw cliError('JXL_OPTIONS', '--effort 10: not with --max-bytes', `remove: --max-bytes or use --effort 9`);
  if ((typeof __RAPIER_JXL_TEACH__ === 'undefined' || __RAPIER_JXL_TEACH__ === true) && options.teach !== undefined && options.jobs > 0)
    throw cliError('JXL_OPTIONS', `--teach: not with --jobs ${options.jobs}`, 'remove: --jobs');
  return {inputs, options};
}

let stillMod, maxMod, jpegMod, decodeMod, animationMod, verifyMod;
const getStill = effort => effort === 10 ? (maxMod ||= import('./max.mjs')) : (stillMod ||= import('./index.mjs'));
const getJpeg = () => (jpegMod ||= import('./jpeg.mjs'));
const getDecode = () => (decodeMod ||= import('./decode.mjs'));
const getAnimation = () => (animationMod ||= import('./animation.mjs'));
const getVerify = () => (verifyMod ||= import('./verify.mjs'));
const getHdr = () => import('./hdr.mjs');

async function firstBytes(path) {
  const file = await open(path, 'r');
  try { const {buffer, bytesRead} = await file.read(new Uint8Array(32), 0, 32, 0); return buffer.subarray(0, bytesRead); }
  finally { await file.close(); }
}

function detectFormat(bytes, filePath = '') {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 6 && bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 56 &&
      (bytes[4] === 55 || bytes[4] === 57) && bytes[5] === 97) return 'gif';
  if (bytes.length >= 12 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 &&
      bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return 'webp';
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (brand === 'avif' || brand === 'avis' || brand === 'mif1') return 'avif';
    if (brand === 'jxl ') return 'jxl';
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0x0a) return 'jxl';
  if (bytes.length >= 12 && [0, 0, 0, 12, 74, 88, 76, 32, 13, 10, 135, 10].every((b, i) => bytes[i] === b)) return 'jxl';
  if (bytes.length >= 7 && bytes[0] === 0x23 && bytes[1] === 0x3f && (String.fromCharCode(...bytes.subarray(2, 9)) === 'RADIANC' || String.fromCharCode(...bytes.subarray(2, 6)) === 'RGBE')) return 'hdr';
  if (bytes.length >= 4 && bytes[0] === 0x76 && bytes[1] === 0x2f && bytes[2] === 0x31 && bytes[3] === 0x01) return 'hdr';
  const ext = extname(filePath).toLowerCase();
  if (ext === '.hdr' || ext === '.exr' || ext === '.pic') return 'hdr';
  if (ext === '.png') return 'png';
  if (ext === '.jpg' || ext === '.jpeg') return 'jpeg';
  if (ext === '.webp') return 'webp';
  if (ext === '.avif') return 'avif';
  if (ext === '.gif') return 'gif';
  if (ext === '.jxl') return 'jxl';
  return null;
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

function makePngChunk(tag, body) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(tag, 4, 'latin1');
  Buffer.from(body.buffer, body.byteOffset, body.byteLength).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

const CICP_PRIMARIES = {srgb: 1, rec2020: 9, 'display-p3': 12}, CICP_TRANSFER = {srgb: 13, linear: 8, pq: 16, hlg: 18};
function pngColorChunks(decoded) {
  if (decoded.rgbaICC?.length) return [makePngChunk('iCCP', Buffer.concat([Buffer.from('ICC profile\0\0', 'latin1'), deflateSync(decoded.rgbaICC)]))];
  const {colorSpace, transferFunction} = decoded;
  if (colorSpace === undefined && transferFunction === undefined && decoded.rgbaColorEncoding === undefined) return [];
  if (colorSpace === 'srgb' && transferFunction === 'srgb') return [makePngChunk('sRGB', Buffer.from([decoded.rgbaColorEncoding?.renderingIntent ?? 1]))];
  if (CICP_PRIMARIES[colorSpace] && CICP_TRANSFER[transferFunction]) return [makePngChunk('cICP', Buffer.from([CICP_PRIMARIES[colorSpace], CICP_TRANSFER[transferFunction], 0, 1]))];
  throw cliError('JXL_UNSUPPORTED', 'PNG colors: unavailable', `use: .jxl or ${COMMAND}/decode`);
}

const EXTRA_CHANNELS = {1: 'depth', 2: 'spot color', 3: 'selection mask', 4: 'black', 5: 'CFA', 6: 'thermal'};
function pngOutput(decoded) {
  if (!isPlainRecord(decoded)) throw fail('JXL_INPUT', "decoded picture: data, width, height");
  let {width, height, data, bitDepth = 8} = decoded;
  dimensions(width, height);
  const kind = typedName.call(data), sampleBytes = {Uint8Array: 1, Uint8ClampedArray: 1, Uint16Array: 2, Float32Array: 4}[kind];
  if (!sampleBytes || typedFields.byteLength.call(data) !== width * height * 4 * sampleBytes)
    throw fail('JXL_INPUT', "PNG RGBA: width * height * 4 samples");
  if (decoded.rgbaICC != null && !(decoded.rgbaICC instanceof Uint8Array))
    throw fail('JXL_INPUT', "ICC profile: Uint8Array");
  let fidelity = 'exact', kept = 'pixels';
  const measurements = [];
  if (data instanceof Float32Array) {
    const signal = !decoded.rgbaICC?.length && CICP_PRIMARIES[decoded.colorSpace] && (decoded.transferFunction === 'pq' || decoded.transferFunction === 'hlg');
    if (!signal || data.some(v => !(v >= 0 && v <= 1))) throw cliError('JXL_UNSUPPORTED', 'PNG floating-point: not exact', `use: .jxl or ${COMMAND}/decode`);
    let maximum = 0;
    data = Uint16Array.from(data, value => {
      const sample = Math.round(value * 65535);
      maximum = Math.max(maximum, Math.abs(value - sample / 65535));
      return sample;
    });
    bitDepth = 16; fidelity = {maxError: 0.5 / 65535}; kept = 'lossy';
    measurements.push({metric: 'max-error', score: maximum, limit: fidelity.maxError, domain: 'encoder-reconstruction'});
  }
  const color = pngColorChunks(decoded);
  const depth = bitDepth === 16 && data instanceof Uint16Array ? 16 : 8;
  const bpp = depth === 16 ? 8 : 4;
  const stride = width * bpp;
  const raw = Buffer.alloc((stride + 1) * height);
  if (depth === 16) {
    for (let y = 0; y < height; y++) {
      const rowStart = y * (stride + 1);
      raw[rowStart] = 0;
      for (let x = 0; x < width * 4; x++) {
        const v = data[y * width * 4 + x];
        raw[rowStart + 1 + x * 2] = v >>> 8;
        raw[rowStart + 2 + x * 2] = v & 255;
      }
    }
  } else {
    const bytes = data instanceof Uint8Array || data instanceof Uint8ClampedArray
      ? data
      : Uint8Array.from(data);
    for (let y = 0; y < height; y++) {
      const at = y * (stride + 1), row = y * stride;
      raw[at] = 1;
      for (let i = 0; i < stride; i++) raw[at + 1 + i] = (bytes[row + i] - (i >= 4 ? bytes[row + i - 4] : 0)) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = 6;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return {bytes: new Uint8Array(Buffer.concat([sig, makePngChunk('IHDR', ihdr), ...color, makePngChunk('IDAT', deflateSync(raw, {level: 6})), makePngChunk('IEND', Buffer.alloc(0))])),
    fidelity, kept, measurements};
}

export function writePngBytes(decoded) { return pngOutput(decoded).bytes; }

async function jpegPixels(raw, displayIn, effort, existing, refusal = null, keep = true) {
  const {recompress} = await getJpeg();
  try {
    if (refusal) throw refusal;
    const exact = existing ?? (keep ? await recompress(raw, {effort: Math.min(effort, 9)}) : null);
    return {exact, decoded: await recompress[Symbol.for('rapier-jxl.jpeg.pixels')](raw, {scale: 8})};
  }
  catch (error) {
    throw cliError(error?.code || 'JXL_JPEG', `JPEG "${displayIn}": unreadable`,
      `convert to PNG; run: npx ${COMMAND} "${replaceExtension(displayIn, '.png')}"`);
  }
}

async function decodeViaRuntime(bytes, format, filePath, maxPixels = PIXELS) {
  const mime = format === 'webp' ? 'image/webp' : format === 'avif' ? 'image/avif' : `image/${format}`;
  if (typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function') {
    let bitmap;
    try {
      bitmap = await createImageBitmap(new Blob([bytes], {type: mime}));
    } catch (cause) {
      throw cliError('JXL_INPUT', `${format.toUpperCase()} "${filePath}": decode failed`,
        `check: "${filePath}" ${format.toUpperCase()}`);
    }
    try {
      const {width, height} = bitmap;
      dimensions(width, height, maxPixels);
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d', {willReadFrequently: true});
      if (!ctx) throw cliError('JXL_PLATFORM', `Canvas 2D unavailable: ${format.toUpperCase()} "${filePath}"`,
        `use: Canvas 2D or PNG "${filePath}"`);
      ctx.drawImage(bitmap, 0, 0);
      const imageData = ctx.getImageData(0, 0, width, height);
      return {data: new Uint8Array(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength), width, height};
    } finally {
      bitmap.close?.();
    }
  }
  const stem = basename(filePath, extname(filePath)) || 'image';
  throw cliError('JXL_PLATFORM',
    `${format.toUpperCase()} "${filePath}": no native decoder`,
    `convert: ffmpeg -i "${filePath}" "${stem}.png"; run: npx ${COMMAND} "${stem}.png"`);
}

async function fitAnimation(encode, picture, {maxBytes, fidelity, effort}) {
  const exact = fidelity === 'exact', ceiling = exact ? 100 : fidelity.quality;
  const first = await encode(picture, {fidelity, effort});
  if (exact || first.bytes.byteLength <= maxBytes) return first;
  const lowest = await encode(picture, {fidelity: {quality: 1}, effort});
  if (lowest.bytes.byteLength > maxBytes) return lowest;
  let best = lowest, lo = 2, hi = Math.ceil(ceiling) - 1;
  while (lo <= hi) {
    const quality = (lo + hi) >> 1;
    const candidate = await encode(picture, {fidelity: {quality}, effort});
    if (candidate.bytes.byteLength <= maxBytes) { best = candidate; lo = quality + 1; }
    else hi = quality - 1;
  }
  return best;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.hdr', '.exr']);

async function collectDirectoryImages(rootDir, skip = null, currentDir = rootDir, out = []) {
  const entries = (await readdir(currentDir, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = join(currentDir, entry.name);
    const file = entry.isSymbolicLink() ? (await stat(fullPath).catch(() => null))?.isFile() : entry.isFile();
    if (entry.isDirectory()) {
      if (fullPath !== skip) await collectDirectoryImages(rootDir, skip, fullPath, out);
    } else if (file && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      out.push({inputPath: fullPath, relPath: relative(rootDir, fullPath)});
    }
  }
  return out;
}

function replaceExtension(filePath, newExt) {
  const ext = extname(filePath);
  return (ext ? filePath.slice(0, -ext.length) : filePath) + newExt;
}

function formatLine(inDisplay, outDisplay, inSize, outSize, note = '') {
  const saved = inSize - outSize;
  const pct = inSize > 0 ? ((saved / inSize) * 100) : 0;
  const extra = note ? `, ${note}` : '';
  if (saved >= 0) {
    return `${inDisplay} -> ${outDisplay}  ${formatBytes(inSize)} -> ${formatBytes(outSize)} (-${pct.toFixed(1)}%, saved ${formatBytes(saved)}${extra})`;
  }
  return `${inDisplay} -> ${outDisplay}  ${formatBytes(inSize)} -> ${formatBytes(outSize)} (+${Math.abs(pct).toFixed(1)}%, +${formatBytes(-saved)}${extra})`;
}

async function encodeFile(raw, format, displayIn, options, runner) {
  const fidelity = options.exact || options.quality === 100 ? 'exact'
    : {quality: options.quality ?? (options.maxBytes !== undefined ? 100 : 90)};
  const produce = (input, engine = runner, details = {}) => {
    const settings = {fidelity, effort: options.effort, ...details};
    return options.maxBytes === undefined ? engine.encode(input, settings)
      : engine.fit ? engine.fit(input, {...settings, maxBytes: options.maxBytes})
      : fitAnimation(engine.encode, input, {...settings, maxBytes: options.maxBytes});
  };
  const pixels = async (picture, engine = runner, details) => {
    const result = await produce(picture, engine, details);
    if (options.maxBytes !== undefined && result.bytes?.byteLength > options.maxBytes) {
      return {result: await imageResult(null, {width: result.width, height: result.height}, {
        owned: true, fidelity, format: 'jxl', maxBytes: options.maxBytes,
        transform: result.transform, readAs: result.readAs,
      })};
    }
    return {result};
  };
  if (format === 'jpeg') {
    let info, exact, refusal = null;
    try { info = jpegInfo(raw, PIXELS); } catch (error) { if (error?.code !== 'JXL_JPEG') throw error; refusal = error; }
    const mode = jpegChoiceMode(info, {effort: options.effort,
      quality: options.exact || options.quality === 100 || options.quality === undefined && !options.jpegPixels ? 100 : 90,
      qualityIntent: (options.quality ?? 90) / 100}, {jpeg: options.jpegPixels ? 'pixels' : undefined});
    if (mode === 'jpeg') {
      const {recompress} = await getJpeg();
      try { exact = await recompress(raw, {effort: Math.min(options.effort, 9)}); } catch (error) { if (error?.code !== 'JXL_JPEG') throw error; refusal = error; }
      if (exact && (options.maxBytes === undefined || exact.bytes.byteLength <= options.maxBytes)) return {result: exact, note: 'exact JPEG'};
      if (exact && fidelity === 'exact') return {result: await imageResult(null, {width: exact.width, height: exact.height}, {
        owned: true, fidelity, format: 'jxl', maxBytes: options.maxBytes, originalBytes: raw.byteLength,
      })};
    }
    const read = await jpegPixels(raw, displayIn, options.effort, exact, refusal, mode !== 'pixels');
    const made = await pixels(read.decoded, runner, {jpeg: 'pixels', [JPEG_SOURCE]: {bytes: raw, info,
      ...(options.maxBytes !== undefined && mode !== 'pixels' && {spentProbes: 1})}});
    if (mode !== 'pixels' && jpegWins(read.exact.bytes, made.result.bytes, made.result, options.maxBytes,
      fidelity === 'exact' ? 1 : fidelity.quality / 100))
      return {result: read.exact, note: 'exact JPEG'};
    return made;
  }
  if (format === 'hdr') return pixels(await (await getHdr()).read(raw));
  if (format === 'png') {
    try { return {result: await produce(new Blob([raw], {type: 'image/png'}))}; }
    catch (error) {
      if (error?.code !== 'JXL_PLATFORM') throw error;
      return pixels(await orientSamples(await readPNG16(raw), {maxPixels: PIXELS}));
    }
  }
  if (format === 'gif') {
    const decoded = readGifBytes(raw, displayIn);
    if (decoded.kind !== 'animation') return pixels(decoded.picture);
    const {encode} = await getAnimation();
    return {...await pixels(decoded.animation, {encode}), note: 'animation'};
  }
  return pixels(await decodeViaRuntime(raw, format, displayIn));
}

async function decodeFile(raw, displayIn, outputPath, named) {
  if (extname(outputPath).toLowerCase() !== '.png') {
    const {restore} = await getJpeg();
    try { return {result: await restore(raw), note: 'exact JPEG', outputPath}; }
    catch (error) {
      if (error?.code !== 'JXL_RECONSTRUCTION') throw error;
      if (named) throw cliError('JXL_RECONSTRUCTION', `"${displayIn}": no JPEG restoration`,
        `run: npx ${COMMAND} "${displayIn}" --out "${replaceExtension(displayIn, '.png')}"`);
      outputPath = replaceExtension(outputPath, '.png');
    }
  }
  const {decode} = await getDecode(), decoded = await decode(raw);
  const dropped = [...(decoded.extraChannels ?? []).filter(channel => channel.type !== 0).map(channel => EXTRA_CHANNELS[channel.type] ?? 'extra channel'),
    ...(decoded.alphaPremultiplied ? ['premultiplied alpha'] : [])];
  let {bytes, fidelity, kept, measurements} = pngOutput(decoded);
  if (dropped.length) ({fidelity, kept} = {fidelity: {maxError: 1}, kept: 'lossy'});
  const transform = decoded.animation || decoded.orientation > 1 ? {width: decoded.width, height: decoded.height, ...(decoded.animation && {frame: 0})} : undefined;
  return {result: await imageResult(bytes, {width: decoded.width, height: decoded.height}, {
    owned: true, fidelity, kept, measurements, format: 'png', transform,
  }), note: dropped.length ? `decoded, dropped ${dropped.join(' and ')}` : 'decoded', outputPath, dropped};
}

async function writeWhole(path, bytes) {
  await mkdir(dirname(path), {recursive: true});
  const temporary = await mkdtemp(join(dirname(path), '.rapier-jxl-')), file = join(temporary, 'image');
  try { await writeFile(file, bytes); await link(file, path); }
  finally { await rm(temporary, {recursive: true, force: true}); }
}

async function processSingleTask(task, options, runner) {
  const {inputPath, displayIn, named} = task;
  const raw = new Uint8Array(await readFile(inputPath));
  if (!raw.byteLength) throw cliError('JXL_INPUT', `"${displayIn}": empty`, 'use: image file');
  const format = detectFormat(raw, inputPath);
  if (!format) throw cliError('JXL_INPUT', `"${displayIn}": unsupported format (expected PNG/JPEG/GIF/WebP/AVIF/JXL/EXR/HDR)`, `run: npx ${COMMAND} photo.png`);
  if (format === 'jxl' && options.maxBytes !== undefined)
    throw cliError('JXL_OPTIONS', `"${displayIn}": --max-bytes not with JXL`, `remove: --max-bytes`);
  const taught = (typeof __RAPIER_JXL_TEACH__ === 'undefined' || __RAPIER_JXL_TEACH__ === true) && options.teach !== undefined && format !== 'jxl' ? [] : null;
  if ((typeof __RAPIER_JXL_TEACH__ === 'undefined' || __RAPIER_JXL_TEACH__ === true) && taught) globalThis.__RAPIER_JXL_TEACH = record => { taught.push(record); };
  const made = format === 'jxl' ? await decodeFile(raw, displayIn, task.outputPath, named)
    : {...await encodeFile(raw, format, displayIn, options, runner), outputPath: task.outputPath};
  if ((typeof __RAPIER_JXL_TEACH__ === 'undefined' || __RAPIER_JXL_TEACH__ === true) && taught) {
    delete globalThis.__RAPIER_JXL_TEACH;
    const {createHash} = await import('node:crypto'), {appendFile} = await import('node:fs/promises');
    const head = {file: displayIn, sha256: createHash('sha256').update(raw).digest('hex'), effort: options.effort,
      quality: options.quality ?? null, bytes: made.result.bytes?.byteLength ?? 0};
    await appendFile(options.teach, [head, ...taught].map(r => JSON.stringify(r, (_, v) => ArrayBuffer.isView(v) ? Array.from(v) : v) + '\n').join(''));
  }
  let verification;
  const record = (skipped, written) => ({result: made.result, inputPath, outputPath: made.outputPath,
    inputBytes: raw.byteLength, outputBytes: made.result.bytes?.byteLength ?? 0,
    effort: format === 'jxl' ? null : options.effort, skipped, written,
    ...(verification && {verification}),
    line: formatLine(displayIn, replaceExtension(task.displayOut, extname(made.outputPath)), raw.byteLength,
      made.result.bytes?.byteLength ?? 0, made.note)});
  if (!made.result.meetsTarget) return record(false, false);
  if (await samePath(made.outputPath, inputPath)) throw cliError('JXL_OPTIONS', `"${displayIn}": output equals input`, '--out: different path');
  if (options.verify && made.dropped?.length) throw cliError('JXL_UNSUPPORTED', `--verify: "${displayIn}" ${made.dropped.join(' and ')}: PNG cannot hold`,
    `run: npx ${COMMAND} "${displayIn}" --out "${task.displayOut}"`);
  if (options.verify) verification = await (await getVerify()).verify(format === 'hdr' ? await (await getHdr()).read(raw) : raw, made.result);
  const shownPath = replaceExtension(task.displayOut, extname(made.outputPath));
  try { await writeWhole(made.outputPath, made.result.bytes); }
  catch (error) {
    if (error.code !== 'EEXIST' || !await stat(made.outputPath).catch(() => null)) throw writeError(error, shownPath);
    const existing = await readFile(made.outputPath).catch(() => null);
    if (!existing || !Buffer.from(made.result.bytes).equals(existing)) throw cliError('JXL_OPTIONS', `"${shownPath}": exists${existing ? ', differing' : ''}`,
      `run: npx ${COMMAND} "${displayIn}" --out "${replaceExtension(shownPath, '')}-${format !== 'jxl' ? 'new' : extname(made.outputPath) === '.png' ? 'decoded' : 'restored'}${extname(made.outputPath)}"`);
    return record(true, false);
  }
  return record(false, true);
}

function writeError(error, shown) {
  if (typeof error?.code === 'string' && error.code.startsWith('JXL_')) return error;
  const why = {EEXIST: 'folder is file', ENOTDIR: 'folder is file', EACCES: 'permission denied',
    EPERM: 'permission denied', EROFS: 'disk read-only', ENOSPC: 'disk full', EDQUOT: 'quota full',
    ENAMETOOLONG: 'name too long'}[error?.code];
  return Object.assign(cliError('JXL_IO', `"${shown}": ${why ?? "host refused"}`,
    why === 'folder is file' ? '--out: inside folder' : '--out: different path'), {cause: error});
}

async function samePath(a, b) {
  if (resolve(a) === resolve(b)) return true;
  try { return await realpath(a) === await realpath(b); } catch { return false; }
}

function friendlyError(error) {
  const own = typeof error?.code === 'string' && error.code.startsWith('JXL_');
  const code = error?.code === 'JXL_SETUP' ? 'JXL_SETUP' : own ? declared(error).code : error?.code ? 'JXL_IO' : 'JXL_INTERNAL';
  if (error?.fix) return {code, message: error.message, hint: error.fix};
  const message = String(error?.message || error).replace(/\.$/, '');
  const hint = code === 'JXL_WASM' ? 'WebAssembly: SIMD'
    : code === 'JXL_DIMENSIONS' ? 'check: dimensions and maxPixels'
    : code === 'JXL_MEMORY' || code === 'JXL_LIMIT' ? 'reduce: --jobs or picture size'
    : code === 'JXL_IO' ? 'check: path permissions'
    : code === 'JXL_INTERNAL' ? 'report: command, input, options'
    : `run: npx ${COMMAND} --help`;
  return {code, message: own ? message : `${message}; ${hint}`, hint};
}

function formatFriendlyError(error) {
  const {code, message} = friendlyError(error);
  return `${COMMAND}: ${code}: ${message}`;
}

const PLACES = ['android', 'ios', 'flutter', 'expo', 'capacitor', 'electron', 'tauri'];
const INTEGRATIONS = {
  emdash: {line: 'An EmDash site: JPEG XL media, the optimizer and the upload filter.', load: () => import('./cli-emdash.mjs'), add: 'runAddEmdash', remove: 'runRemoveEmdash', reports: true},
  wordpress: {line: 'A WordPress site: JPEG XL copies of uploads, with originals for other browsers.', load: () => import('./cli-places.mjs'), add: 'runAddWordpress', remove: 'runRemoveWordpress'},
  payload: {line: 'A Payload CMS project: JPEG XL beside uploads and sizes, with <picture> and Vary: Accept.', load: () => import('./cli-payload.mjs'), add: 'runAddPayload', remove: 'runRemovePayload'},
  astro: {line: 'An Astro site: the image service that writes JPEG XL.', load: () => import('./cli-astro.mjs'), add: 'runAddAstro', remove: 'runRemoveAstro'},
  ...Object.fromEntries([['vite', 'A Vite project, SvelteKit or Nuxt: import hero from "./hero.jpg?jxl".'], ['webpack', 'A webpack 5 or Rspack project: import hero from "./hero.jpg?jxl".'],
    ['next', 'A Next.js project: next/image answers with JPEG XL where the browser accepts it.'], ['netlify', 'A Netlify site: a .jxl beside each published JPEG and PNG.'],
    ['void', 'A Void app: pictures stored as JPEG XL, served with the exact original.']]
    .map(([host, line]) => [host, {line, host, add: 'runAdd', remove: 'runRemove', load: () => import('./cli-add.mjs')}])),
  workers: {line: 'A Cloudflare Worker: serves JPEG XL to browsers that ask.', load: () => import('./cli-workers.mjs'), add: 'runAddWorkers', remove: 'runRemoveWorkers'},
  ...Object.fromEntries([['r2', 'A Cloudflare R2 bucket: a JPEG XL beside every JPEG and PNG put in it.'], ['agents', 'A Cloudflare Agents SDK project: JPEG XL tools for agents.']]
    .map(([host, line]) => [host, {line, host, add: 'runAddCloudflare', remove: 'runRemoveCloudflare', load: () => import('./cli-cloudflare.mjs')}])),
  ...Object.fromEntries([['apache', 'An Apache or LiteSpeed folder: .htaccess serves .jxl by Accept with Vary: Accept.'], ['nginx', 'An nginx site: jpegxl.conf serves .jxl by Accept with try_files and Vary: Accept.'], ['caddy', 'A Caddy site: jpegxl.caddy serves .jxl by Accept with try_files and Vary: Accept.']]
    .map(([host, line]) => [host, {line, host, add: 'runAddServer', remove: 'runRemoveServer', load: () => import('./cli-servers.mjs')}])),
  ...Object.fromEntries(PLACES.map(host => [host, {host, add: 'runAddPlace', remove: 'runRemovePlace', load: () => import('./cli-places.mjs')}])),
  ...Object.fromEntries(['sveltekit', 'nuxt'].map(as => [as, {host: 'vite', as, add: 'runAdd', remove: 'runRemove', load: () => import('./cli-add.mjs')}]))
};

async function verifyFiles(argv, {cwd, json, emit, stdout, stderr}, caller) {
  const split = argv.findIndex(arg => String(arg) === '--'), words = split < 0 ? argv : argv.slice(0, split), after = split < 0 ? [] : argv.slice(split + 1);
  const paths = [...words.filter(arg => String(arg) !== '--json'), ...after];
  if (paths.length !== 2 || words.some(path => String(path).startsWith('-') && String(path) !== '--json'))
    throw cliError('JXL_OPTIONS', 'verify: source + JXL, or two folders', `run: npx ${COMMAND} verify photos/ out/`);
  const [from, to] = paths.map(path => resolve(cwd, path)), show = path => relative(cwd, path) || basename(path);
  const kinds = await Promise.all([from, to].map(path => stat(path).then(
    info => info.isFile() || info.isDirectory() ? info.isDirectory() : undefined,
    cause => {
      if (cause?.code === 'ENOENT' || cause?.code === 'ENOTDIR') return null;
      throw Object.assign(cliError('JXL_IO', `"${show(path)}": inspection failed`,
        'check: path permissions'), {cause});
    })));
  kinds.forEach((kind, i) => { if (kind === undefined) throw cliError('JXL_INPUT', `"${paths[i]}": not a file or folder`, 'use: picture file or folder'); });
  kinds.forEach((kind, i) => { if (kind === null) throw cliError('JXL_INPUT', `"${paths[i]}": missing`, 'check: path'); });
  if (kinds[0] !== kinds[1]) throw cliError('JXL_OPTIONS', 'verify: two files or two folders', `run: npx ${COMMAND} verify photos/ out/`);
  let pairs = [{original: from, file: to}];
  if (kinds[0]) {
    const items = await collectDirectoryImages(from, to), exact = new Map(items.map(item => [item.relPath, item.inputPath])), stems = new Map();
    for (const item of items) { const stem = replaceExtension(item.relPath, ''); stems.set(stem, stems.has(stem) ? null : item.inputPath); }
    const originalOf = name => { const stem = replaceExtension(name, ''); return exact.get(stem) ?? stems.get(stem) ?? null; };
    const files = (await readdir(to, {recursive: true})).filter(name => extname(name).toLowerCase() === '.jxl').sort();
    if (!files.length) throw cliError('JXL_INPUT', `"${paths[1]}": no .jxl files`, `run: npx ${COMMAND} "${paths[0]}" --out "${paths[1]}"`);
    pairs = files.map(name => ({original: originalOf(name), file: join(to, name)}));
  }
  const [{verify}, {header}] = await Promise.all([getVerify(), import('./metadata.mjs')]);
  let failed = 0, checked = 0;
  for (const {original, file} of pairs) {
    const line = {type: 'verify', original: original && show(original), file: show(file)};
    try {
      if (!original) throw cliError('JXL_INPUT', `"${show(file)}": no matching original in "${paths[0]}"`, `run: npx ${COMMAND} verify <original> "${show(file)}"`);
      const bytes = new Uint8Array(await readFile(file).catch(cause => {
        if (cause?.code === 'ENOENT' || cause?.code === 'ENOTDIR')
          throw cliError('JXL_INPUT', `"${show(file)}": missing`, `run: npx ${COMMAND} "${show(original)}" --out "${show(file)}"`);
        throw Object.assign(cliError('JXL_IO', `"${show(file)}": unreadable`, 'check: file permissions'), {cause});
      }));
      const source = new Uint8Array(await readFile(original).catch(cause => {
        if (cause?.code === 'ENOENT' || cause?.code === 'ENOTDIR')
          throw cliError('JXL_INPUT', `"${show(original)}": missing`, 'check: original path');
        throw Object.assign(cliError('JXL_IO', `"${show(original)}": unreadable`, 'check: file permissions'), {cause});
      })), kind = detectFormat(source, original), jpeg = kind === 'jpeg';
      const reference = kind === 'hdr' ? await (await getHdr()).read(source) : new Blob([source]);
      const h = header(bytes), [width, height] = h.orientation > 4 ? [h.height, h.width] : [h.width, h.height];
      const record = {bytes, width, height, format: 'jxl', source: null, meetsTarget: true, measurements: []};
      let receipt, refusal;
      for (const claim of [...(jpeg ? [{fidelity: 'exact', kept: 'jpeg-bytes'}] : []), {fidelity: 'exact', kept: 'pixels'}, {fidelity: {quality: 1}, kept: 'lossy'}]) {
        try { receipt = await verify(claim.kept === 'jpeg-bytes' ? source : reference, {...record, ...claim}); break; }
        catch (error) { refusal = error; if (!['JXL_TARGET', 'JXL_RECONSTRUCTION'].includes(error?.code)) break; }
      }
      checked++;
      if (!receipt) throw cliError(refusal?.code || 'JXL_TARGET', `"${show(file)}": not copy of "${show(original)}": ${String(refusal?.message || refusal).replace(/\.$/, '')}`,
        `run: npx ${COMMAND} "${show(original)}" --out "${replaceExtension(show(file), '')}-new.jxl"`);
      const kept = receipt.kind === 'jpeg-restore' ? 'jpeg-bytes' : receipt.kind === 'pixels' ? 'pixels' : 'lossy';
      const score = kept === 'lossy' ? Math.round(receipt.score * 100) / 100 : undefined;
      if (json) await emit({...line, verified: true, kept, ...(score !== undefined && {metric: receipt.metric, score})});
      else await stdout(`${line.file}: ${kept === 'jpeg-bytes' ? 'restores the JPEG exactly' : kept === 'pixels' ? 'every pixel exact' : `lossy, ${receipt.metric} ${score}`} (${line.original})`);
    } catch (error) {
      if (caller.failed) throw caller.reason;
      failed++;
      if (json) await emit({...line, verified: false, error: friendlyError(error)});
      else await stderr(formatFriendlyError(error));
    }
  }
  if (json) await emit({type: 'summary', files: pairs.length, verified: pairs.length - failed, failed});
  return {exitCode: failed || !checked ? 1 : 0, files: []};
}

export async function runCli(argv = process.argv.slice(2), io = {}) {
  argv = cliArgs(argv);
  if (!isPlainRecord(io)) throw cliError('JXL_OPTIONS', 'io: object', 'use: object');
  const {cwd, stdout, stderr} = io;
  if (cwd !== undefined && typeof cwd !== 'string') throw cliError('JXL_OPTIONS', 'cwd: string path', 'use: folder string');
  for (const callback of [stdout, stderr]) if (callback !== undefined && typeof callback !== 'function')
    throw cliError('JXL_OPTIONS', 'output callback: function', 'stdout/stderr: functions');
  const caller = {failed: false}, pending = [];
  const remember = reason => { if (!caller.failed) { caller.failed = true; caller.reason = reason; } };
  const output = callback => callback === undefined ? undefined : value => {
    if (caller.failed) throw caller.reason;
    try {
      const result = Promise.resolve(callback(value));
      pending.push(result.then(undefined, reason => { remember(reason); }));
      return result;
    } catch (reason) { remember(reason); throw caller.reason; }
  };
  const result = await runCliHere(argv, {cwd, stdout: output(stdout), stderr: output(stderr)}, caller);
  await Promise.all(pending);
  if (caller.failed) throw caller.reason;
  return result;
}

async function runCliHere(argv, io, caller, extra = {}) {
  const cwd = io.cwd ? resolve(io.cwd) : process.cwd();
  const stdout = io.stdout ?? (line => process.stdout.write(line + '\n'));
  const stderr = io.stderr ?? (line => process.stderr.write(line + '\n'));
  const started = performance.now(), elapsed = since => Math.round(performance.now() - since);
  let json = argv.some(arg => String(arg) === '--json');
  const emit = value => stdout(JSON.stringify(value));
  const onDisk = results => results.filter(r => r.written || r.skipped), total = (results, key) => onDisk(results).reduce((n, r) => n + r[key], 0);
  const summary = (results, files, failed, error) => ({type: 'summary', files, written: results.filter(r => r.written).length,
    skipped: results.filter(r => r.skipped).length, failed, inputBytes: total(results, 'inputBytes'),
    outputBytes: total(results, 'outputBytes'), ms: elapsed(started), ...(error ? {error: friendlyError(error)} : {})});
  const refuse = async error => { if (caller.failed) throw caller.reason; if (json) await emit(summary([], 0, 0, error)); else await stderr(formatFriendlyError(error)); return {exitCode: 1, files: []}; };
  const words = argv.filter(arg => String(arg) !== '--json');
  if (words[0] === 'add' && words.length === 1) {
    const places = [...Object.entries(INTEGRATIONS).filter(([, host]) => host.line).map(([name, host]) => ({name, line: host.line})), ...(await import('./cli-places.mjs')).placeLines()];
    if (json) await emit({type: 'places', places}); else for (const {name, line} of places) await stdout(`${name.padEnd(9)}${line}`);
    return {exitCode: 0, files: []};
  }
  if (words[0] === 'add' || words[0] === 'remove') {
    try {
      const verb = words[0], target = words[1], host = Object.hasOwn(INTEGRATIONS, target) ? INTEGRATIONS[target] : null, names = Object.keys(INTEGRATIONS);
      const removable = names.filter(n => INTEGRATIONS[n].remove);
      if (!host?.[verb]) throw cliError('JXL_OPTIONS', target === undefined || String(target).startsWith('-') ? `integration: name for ${verb}`
        : host ? `${verb} ${target}: no integration` : `unknown integration: "${target}"; use ${names.join(', ')}`,
        verb === 'add' ? `run: npx ${COMMAND} add <name>`
          : `run: npx ${COMMAND} remove <name>: ${removable.join(', ')}`);
      const setup = await host.load(), tail = words.slice(2);
      if (tail.length === 1 && ['--help', '-h'].includes(String(tail[0]))) {
        const helpLines = [];
        await setup[host[verb]](...host.host ? [host.host] : [], ['--help'], {cwd, version: VERSION, name: await ownName(), stdout: line => helpLines.push(line), as: host.as});
        const usage = helpLines.join('\n').trimEnd();
        if (json) await emit({type: 'help', usage}); else await stdout(usage);
        return {exitCode: 0, files: []};
      }
      const rest = host.reports ? tail : [...tail, ...(json ? ['--json'] : [])];
      const done = await setup[host[verb]](...host.host ? [host.host] : [], rest, {cwd, version: VERSION, name: await ownName(), quiet: json, stdout: json && host.reports ? () => {} : stdout, as: host.as});
      if (json && host.reports) await emit({type: verb, integration: target, dryRun: Boolean(done?.dryRun), ...(done ?? {})});
      return {exitCode: 0, files: []};
    } catch (error) { return refuse(error); }
  }
  if (argv[0] === 'site') {
    try {
      const {runSite, SITE_HELP} = await import('./cli-site.mjs');
      const done = await runSite(argv.slice(1), {
        cwd, version: VERSION, stdout, stderr, checkFlags: parseCliArgs,
        encodeImages: async (files, flags) => {
          const lines = [];
          const res = await runCliHere([...files, '--keep-extension', '--json', ...flags], {
            cwd, stdout: l => lines.push(l), stderr: () => {},
          }, caller, {inFolder: true});
          return {...res, lines};
        },
      });
      if (done.help) {
        if (json) await emit({type: 'help', usage: SITE_HELP.trimEnd()});
        else await stdout(SITE_HELP.trimEnd());
        return {exitCode: 0, files: []};
      }
      return {exitCode: done.exitCode, files: []};
    } catch (error) { return refuse(error); }
  }
  if (argv[0] === 'verify') {
    try { return await verifyFiles(argv.slice(1), {cwd, json, emit, stdout, stderr}, caller); } catch (error) { return refuse(error); }
  }
  if (argv[0] === 'selftest') {
    try {
      const {runSelftest, SELFTEST_HELP} = await import('./cli-selftest.mjs');
      const {exitCode, record, out} = await runSelftest(argv.slice(1).filter(arg => String(arg) !== '--json'), {cwd, version: VERSION, stdout: json ? () => {} : stdout,
        modules: {still: getStill, jpeg: getJpeg, decode: getDecode, verify: getVerify}});
      if (json) await emit(record ? {type: 'selftest', status: record.status, file: relative(cwd, out) || out, ...record.summary}
        : {type: 'help', usage: SELFTEST_HELP.trimEnd()});
      return {exitCode, files: []};
    } catch (error) { return refuse(error); }
  }
  let parsed;
  try { parsed = parseCliArgs(argv); } catch (error) { return refuse(error); }
  const {inputs, options} = parsed;
  json = options.json;
  if (options.help) { if (json) await emit({type: 'help', usage: HELP_TEXT.trimEnd()}); else await stdout(HELP_TEXT.trimEnd()); return {exitCode: 0, files: []}; }
  if (options.version) { if (json) await emit({type: 'version', version: VERSION}); else await stdout(VERSION); return {exitCode: 0, files: []}; }
  if (!inputs.length) return refuse(cliError('JXL_OPTIONS', 'input: picture or folder required', `run: npx ${COMMAND} photo.png`));

  let configured = null;
  try {
    const found = [];
    for (const rawInput of inputs) {
      if (rawInput === '-') throw cliError('JXL_INPUT', 'stdin: file required', 'use: file or ./-');
      const fullInput = resolve(cwd, rawInput);
      let info;
      try { info = await stat(fullInput); }
      catch (cause) {
        if (cause?.code === 'ENOENT' || cause?.code === 'ENOTDIR') throw cliError('JXL_INPUT', `"${rawInput}": missing`, 'check: path');
        throw Object.assign(cliError('JXL_IO', `"${rawInput}": inspection failed`,
          'check: path permissions'), {cause});
      }
      if (!info.isFile() && !info.isDirectory()) throw cliError('JXL_INPUT', `"${rawInput}": not a file or folder`, 'use: picture file or folder');
      found.push({rawInput, fullInput, isDirectory: info.isDirectory()});
    }
    const many = found.length > 1 || found[0].isDirectory;
    const out = options.out === undefined ? null : resolve(cwd, options.out);
    let outIsDir = many || /[\\/]$/.test(options.out ?? '');
    if (out !== null) {
      const outInfo = await stat(out).catch(() => null);
      if (outInfo?.isDirectory()) outIsDir = true;
      if (many && outInfo?.isFile()) throw cliError('JXL_OPTIONS', `--out "${options.out}": folder for multiple inputs`, 'use: --out dist/');
    }
    const tasks = [], show = path => relative(cwd, path) || basename(path);
    const automaticName = (path, ext) => options.keepExtension && ext === '.jxl' ? path + ext : replaceExtension(path, ext);
    for (const {rawInput, fullInput, isDirectory} of found) {
      if (isDirectory) {
        const items = await collectDirectoryImages(fullInput, out);
        if (!items.length) throw cliError('JXL_INPUT', `"${rawInput}": no supported images`, 'use: picture or image folder');
        for (const item of items) {
          const outputPath = automaticName(out ? join(out, item.relPath) : item.inputPath, '.jxl');
          tasks.push({inputPath: item.inputPath, outputPath, displayIn: show(item.inputPath), displayOut: show(outputPath), named: false, inFolder: true});
        }
      } else {
        const ext = detectFormat(await firstBytes(fullInput)) === 'jxl' ? '.jpg' : '.jxl';
        const outputPath = out ? (outIsDir ? join(out, automaticName(basename(fullInput), ext)) : out) : automaticName(fullInput, ext);
        const named = out !== null && !outIsDir, want = ext === '.jxl' ? ['.jxl'] : ['.jpg', '.jpeg', '.png'];
        if (named && !want.includes(extname(out).toLowerCase())) throw cliError('JXL_OPTIONS',
          `--out "${options.out}": need ${ext === '.jxl' ? '.jxl' : '.jpg/.jpeg/.png'}`,
          `use: ${want.map(e => `"${replaceExtension(options.out, e)}"`).join(' or ')}`);
        tasks.push({inputPath: fullInput, outputPath, displayIn: show(fullInput), displayOut: show(outputPath), named: out !== null && !outIsDir, ...(extra.inFolder && {inFolder: true})});
      }
    }
    const counts = new Map();
    for (const task of tasks) {
      const key = task.outputPath.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const task of tasks) {
      if (!task.named && extname(task.outputPath).toLowerCase() === '.jxl' && counts.get(task.outputPath.toLowerCase()) > 1) {
        task.outputPath = join(dirname(task.outputPath), basename(task.inputPath) + '.jxl');
        task.displayOut = show(task.outputPath);
      }
    }
    const seen = new Map();
    for (const task of tasks) {
      const key = task.outputPath.toLowerCase(), other = seen.get(key);
      if (other) throw cliError('JXL_OPTIONS', `"${other.displayIn}" + "${task.displayIn}": same output "${task.displayOut}"`,
        `use: distinct --out paths`);
      seen.set(key, task);
    }

    let runner;
    if (options.jobs > 0) {
      configured = await getStill(options.effort);
      configured.configure({helpers: {count: options.jobs, memoryBytes: Math.max(1, options.jobs) * 512 * 1024 * 1024}});
      runner = {encode: (picture, encodeOptions) => configured.encode(picture, encodeOptions),
        fit: (picture, fitOptions) => configured.fit(picture, fitOptions)};
    } else runner = {encode: async (picture, encodeOptions) => (await getStill(options.effort)).encode(picture, encodeOptions),
      fit: async (picture, fitOptions) => (await getStill(options.effort)).fit(picture, fitOptions)};

    const results = [];
    let next = 0, failed = 0, unread = 0;
    await Promise.all(Array.from({length: options.jobs > 0 ? Math.min(tasks.length, options.jobs) : 1}, async () => {
      while (next < tasks.length) {
        const task = tasks[next++], begun = performance.now();
        try {
          const result = await processSingleTask(task, options, runner);
          results.push(result);
          const accepted = result.result.meetsTarget;
          if (!accepted) failed++;
          if (!json) {
            if (accepted) await stdout(result.line);
            else await stderr(formatFriendlyError(result.result.reason ?? fail('JXL_TARGET', "target: raise maxBytes or lower quality")));
          } else await emit({type: 'file', input: task.displayIn, output: replaceExtension(task.displayOut, extname(result.outputPath)),
            inputBytes: result.inputBytes, outputBytes: result.outputBytes, ...(result.written || result.skipped ? withoutBytes(resultJSON({...result.result, bytes: null})) : resultJSON(result.result)),
            effort: result.effort, ms: elapsed(begun), skipped: result.skipped, written: result.written,
            ...(result.verification && {verification: result.verification})});
        } catch (error) {
          if (caller.failed) throw caller.reason;
          if (task.inFolder && error?.code === 'JXL_PLATFORM') {
            unread++;
            if (json) await emit({type: 'unread', input: task.displayIn, reason: friendlyError(error)});
            else await stderr(`${task.displayIn}: not converted: ${formatFriendlyError(error)}`);
            continue;
          }
          failed++;
          if (json) await emit({type: 'file', input: task.displayIn, output: task.displayOut, ms: elapsed(begun), error: friendlyError(error),
            ...(error?.verification && {verification: error.verification})});
          else await stderr(tasks.length > 1 ? `${task.displayIn}: ${formatFriendlyError(error)}` : formatFriendlyError(error));
        }
      }
    }));
    if (json) await emit({...summary(results, tasks.length, failed), unread});
    else if (tasks.length > 1) {
      const totalIn = total(results, 'inputBytes'), totalOut = total(results, 'outputBytes');
      const saved = totalIn - totalOut, pct = totalIn > 0 ? Math.abs(saved / totalIn) * 100 : 0;
      const completed = results.filter(result => result.result.meetsTarget).length;
      await stdout(`${completed} of ${tasks.length} files: ${formatBytes(totalIn)} -> ${formatBytes(totalOut)} (${saved >= 0 ? '-' : '+'}${pct.toFixed(1)}%)${failed ? `, ${failed} failed` : ''}${unread ? `, ${unread} not read here` : ''}`);
    }
    return {exitCode: failed ? 1 : 0, files: results};
  } catch (error) {
    return refuse(error);
  } finally {
    if (configured) { await configured.close().catch(() => {}); configured.configure(); }
  }
}

const isMain = await (async () => {
  if (!process.argv[1]) return false;
  try { return await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url)); } catch { return false; }
})();
export function nodeBelowFloor(version = process.versions.node) {
  if (typeof version !== 'string') throw cliError('JXL_OPTIONS', 'version: string', 'version: 22.3.0');
  return belowFloor(version) ? `${COMMAND}: JXL_PLATFORM: Node ${version} is too old. ${FLOOR}` : null;
}
if (isMain) {
  const old = nodeBelowFloor();
  if (old) { process.stderr.write(old + '\n'); process.exit(1); }
  const {exitCode} = await runCli(process.argv.slice(2));
  if (exitCode !== 0) process.exitCode = exitCode;
}

