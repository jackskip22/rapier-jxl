#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import {readFile, writeFile, stat, readdir, mkdir, mkdtemp, link, rename, rm, realpath} from 'node:fs/promises';
import {basename, dirname, extname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {deflateSync, inflateSync} from 'node:zlib';
import {fail, dimensions} from './primitives.mjs';

const VERSION = typeof __RAPIER_JXL_VERSION__ !== 'undefined' ? __RAPIER_JXL_VERSION__ : '8.0.1';

export const HELP_TEXT = `Usage: rapier-jxl <file|folder...> [options]

Encode images to JPEG XL (.jxl), or restore recompressed JPEGs.
JPEGs are recompressed losslessly by default and restore byte-for-byte.

Options:
  -q, --quality <1-100>    Target quality (default: 90; JPEG default: exact)
  -e, --effort <1-9>       Encoding effort, 1 fastest to 9 smallest (default: 7)
      --max-bytes <size>   Fit output under byte budget (e.g. 80KB, 1.5MB, 120000)
  -l, --lossless           Exact lossless encoding (default for JPEG)
  -o, --out <path>         Output file or directory
  -j, --jobs <0-16>        Helper worker threads (default: 0)
  -h, --help               Show this help
  -v, --version            Show version

Examples:
  npx rapier-jxl photo.png
  npx rapier-jxl photo.jpg
  npx rapier-jxl photos/ --effort 6 --jobs 4
  npx rapier-jxl hero.png --quality 82 --out dist/hero.jxl
  npx rapier-jxl banner.png --max-bytes 100KB
  npx rapier-jxl photo.jxl --out restored.jpg
`;

const FLAG_FIXES = {
  '--output': 'use --out <path>',
  '--out-dir': 'use --out <dir>',
  '--outdir': 'use --out <dir>',
  '--threads': 'use --jobs <1-16>',
  '--workers': 'use --jobs <1-16>',
  '--helpers': 'use --jobs <1-16>',
  '--parallel': 'use --jobs <1-16>',
  '--exact': 'use --lossless',
  '--max-size': 'use --max-bytes <size> (for example: --max-bytes 100KB)',
  '--target-size': 'use --max-bytes <size> (for example: --max-bytes 100KB)',
  '--target-bytes': 'use --max-bytes <size> (for example: --max-bytes 100KB)',
  '--budget': 'use --max-bytes <size> (for example: --max-bytes 100KB)',
  '--recursive': 'omit --recursive; folders are processed recursively by default',
  '-r': 'omit -r; folders are processed recursively by default',
};

function cliError(code, what, fix) {
  return Object.assign(new Error(`${what} Fix: ${fix}`), {code, fix});
}

export function parseByteSize(raw) {
  const text = String(raw ?? '').trim();
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|k|kib|mb|m|mib)?$/i.exec(text);
  if (!match) {
    throw cliError('JXL_OPTIONS', `Invalid --max-bytes "${raw}" (expected a positive byte count such as 80000, 80KB, or 1.5MB).`,
      'pass a positive size, for example: npx rapier-jxl photo.png --max-bytes 100KB');
  }
  const value = Number(match[1]);
  const unit = (match[2] || 'b').toLowerCase();
  const scale = unit === 'k' || unit === 'kb' ? 1000
    : unit === 'kib' ? 1024
    : unit === 'm' || unit === 'mb' ? 1000000
    : unit === 'mib' ? 1048576
    : 1;
  const bytes = Math.round(value * scale);
  if (!Number.isSafeInteger(bytes) || bytes < 1) {
    throw cliError('JXL_OPTIONS', `Invalid --max-bytes "${raw}" (must be at least 1 byte).`,
      'pass a positive byte budget, for example: npx rapier-jxl photo.png --max-bytes 50KB');
  }
  return bytes;
}

export function formatBytes(bytes) {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1000000).toFixed(2)} MB`;
}

export function parseCliArgs(argv) {
  const inputs = [];
  const options = {
    help: false,
    version: false,
    quality: undefined,
    effort: 7,
    effortExplicit: false,
    maxBytes: undefined,
    lossless: false,
    out: undefined,
    jobs: 0,
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
        if (inlineValue === '') throw cliError('JXL_OPTIONS', `Missing value for ${name}.`, `pass a value, for example: ${example}`);
        return inlineValue;
      }
      if (i + 1 >= argv.length || String(argv[i + 1]).startsWith('-')) {
        throw cliError('JXL_OPTIONS', `Missing value for ${name}.`, `pass a value, for example: ${example}`);
      }
      return String(argv[++i]);
    };

    if (flag === '-h' || flag === '--help') {
      options.help = true;
    } else if (flag === '-v' || flag === '--version') {
      options.version = true;
    } else if (flag === '-l' || flag === '--lossless') {
      if (inlineValue !== undefined) throw cliError('JXL_OPTIONS', `--lossless takes no value (got "${arg}").`, 'write --lossless without a value.');
      options.lossless = true;
    } else if (flag === '-q' || flag === '--quality') {
      const val = takeValue('--quality', 'npx rapier-jxl photo.png --quality 85');
      const num = Number(val);
      if (!Number.isFinite(num) || num < 1 || num > 100) {
        throw cliError('JXL_OPTIONS', `Invalid --quality "${val}" (must be a number from 1 to 100).`,
          'pass a quality between 1 and 100, for example: npx rapier-jxl photo.png --quality 85');
      }
      options.quality = num;
    } else if (flag === '-e' || flag === '--effort') {
      const val = takeValue('--effort', 'npx rapier-jxl photo.png --effort 7');
      const num = Number(val);
      if (!Number.isInteger(num) || num < 1 || num > 9) {
        throw cliError('JXL_OPTIONS', `Invalid --effort "${val}" (must be an integer from 1 to 9).`,
          'pass an integer effort from 1 (fastest) to 9 (smallest), for example: npx rapier-jxl photo.png --effort 6');
      }
      options.effort = num;
      options.effortExplicit = true;
    } else if (flag === '--max-bytes') {
      const val = takeValue('--max-bytes', 'npx rapier-jxl photo.png --max-bytes 100KB');
      options.maxBytes = parseByteSize(val);
    } else if (flag === '-o' || flag === '--out') {
      options.out = takeValue('--out', 'npx rapier-jxl photo.png --out dist/photo.jxl');
    } else if (flag === '-j' || flag === '--jobs') {
      const val = takeValue('--jobs', 'npx rapier-jxl photos/ --jobs 4');
      const num = Number(val);
      if (!Number.isInteger(num) || num < 0 || num > 16) {
        throw cliError('JXL_OPTIONS', `Invalid --jobs "${val}" (must be an integer from 0 to 16).`,
          'pass a helper count from 0 to 16, for example: npx rapier-jxl photos/ --jobs 4');
      }
      options.jobs = num;
    } else if (Object.hasOwn(FLAG_FIXES, flag)) {
      throw cliError('JXL_OPTIONS', `Unknown option "${flag}".`, `${FLAG_FIXES[flag]}.`);
    } else {
      throw cliError('JXL_OPTIONS', `Unknown option "${flag}".`,
        'run npx rapier-jxl --help to see supported options (--quality, --effort, --max-bytes, --lossless, --out, --jobs).');
    }
  }

  if (options.lossless && options.quality !== undefined && options.quality < 100) {
    throw cliError('JXL_OPTIONS', `Cannot combine --lossless with --quality ${options.quality}.`,
      `remove --lossless for lossy quality ${options.quality}, or remove --quality ${options.quality} for lossless encoding.`);
  }
  return {inputs, options};
}

let stillMod, jpegMod, decodeMod, animationMod, codecMod;
const getStill = () => (stillMod ||= import('./index.mjs'));
const getJpeg = () => (jpegMod ||= import('./jpeg.mjs'));
const getDecode = () => (decodeMod ||= import('./decode.mjs'));
const getAnimation = () => (animationMod ||= import('./animation.mjs'));
const getCodec = () => (codecMod ||= import('./codec.mjs'));

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
  const ext = extname(filePath).toLowerCase();
  if (ext === '.png') return 'png';
  if (ext === '.jpg' || ext === '.jpeg') return 'jpeg';
  if (ext === '.webp') return 'webp';
  if (ext === '.avif') return 'avif';
  if (ext === '.gif') return 'gif';
  if (ext === '.jxl') return 'jxl';
  return null;
}

const PNG_PASSES = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
const PNG_CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4};
const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};
const crcTable = Uint32Array.from({length: 256}, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

export function readPngBytes(fileBytes, filePath = 'input.png', maxPixels = 40000000) {
  const png = Buffer.from(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength);
  if (png.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => png[i] === b)) {
    throw cliError('JXL_INPUT', `"${filePath}" does not have a valid PNG signature.`,
      `verify that "${filePath}" is an undamaged PNG file.`);
  }
  let header = null, palette = null, transparency = null, cicp = null, iccp = null, srgb = null, gama = null, chrm = null;
  const idat = [];
  let seenData = false, ended = false;
  for (let at = 8; at + 12 <= png.length;) {
    const length = png.readUInt32BE(at), end = at + 12 + length;
    if (length > 0x7fffffff || end > png.length) {
      throw cliError('JXL_INPUT', `"${filePath}" contains a truncated PNG chunk.`, `re-export "${filePath}" as a complete PNG.`);
    }
    const tag = png.toString('latin1', at + 4, at + 8);
    const body = png.subarray(at + 8, end - 4);
    if (crc32(png.subarray(at + 4, end - 4)) !== png.readUInt32BE(end - 4)) {
      throw cliError('JXL_INPUT', `"${filePath}" has a corrupted PNG chunk (${tag} checksum mismatch).`, `re-save "${filePath}" from the source image.`);
    }
    if (tag === 'IHDR') {
      if (header || length !== 13) throw cliError('JXL_INPUT', `"${filePath}" has an invalid PNG IHDR chunk.`, `re-export "${filePath}".`);
      header = {width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colour: body[9], comp: body[10], filter: body[11], interlace: body[12]};
    } else if (tag === 'PLTE') palette = body;
    else if (tag === 'tRNS') transparency = body;
    else if (tag === 'cICP' && length === 4) cicp = body;
    else if (tag === 'iCCP') iccp = body;
    else if (tag === 'sRGB' && length === 1) srgb = body;
    else if (tag === 'gAMA' && length === 4) gama = body;
    else if (tag === 'cHRM' && length === 32) chrm = body;
    else if (tag === 'acTL' || tag === 'fcTL' || tag === 'fdAT') {
      throw cliError('JXL_UNSUPPORTED', `"${filePath}" is an animated PNG (APNG).`,
        'convert animated PNG frames or pass a GIF/still PNG.');
    } else if (tag === 'IDAT') {
      seenData = true;
      idat.push(body);
    } else if (tag === 'IEND') {
      ended = true;
      break;
    }
    at = end;
  }
  if (!header || !seenData || !ended) {
    throw cliError('JXL_INPUT', `"${filePath}" is an incomplete PNG file.`, `re-export "${filePath}" so it contains IHDR, IDAT, and IEND chunks.`);
  }
  const {width, height, depth, colour, comp, filter, interlace} = header;
  dimensions(width, height, maxPixels);
  const channels = PNG_CHANNELS[colour];
  if (!channels || comp !== 0 || filter !== 0 || interlace > 1 || ![1, 2, 4, 8, 16].includes(depth) ||
      (colour === 3 && (!palette || depth === 16)) || ((colour === 2 || colour === 4 || colour === 6) && depth < 8)) {
    throw cliError('JXL_INPUT', `"${filePath}" uses an unsupported PNG layout (color type ${colour}, bit depth ${depth}).`,
      `save "${filePath}" as standard 8-bit or 16-bit PNG.`);
  }

  const passes = interlace ? PNG_PASSES : [[0, 0, 1, 1]];
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  let expected = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const w = Math.max(0, Math.ceil((width - x0) / dx));
    const h = Math.max(0, Math.ceil((height - y0) / dy));
    if (w && h) expected += h * (1 + Math.ceil((w * bitsPerPixel) / 8));
  }
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat), {maxOutputLength: expected});
  } catch {
    throw cliError('JXL_INPUT', `"${filePath}" has invalid PNG deflate data.`, `re-save "${filePath}" from a valid image source.`);
  }
  if (raw.length !== expected) {
    throw cliError('JXL_INPUT', `"${filePath}" PNG image data length does not match its dimensions.`, `re-save "${filePath}".`);
  }

  const description = {}, unsupported = what => cliError('JXL_UNSUPPORTED', `"${filePath}" declares ${what}, which JPEG XL encoding here cannot keep.`,
    `re-save it with an sRGB, Display P3 or ICC profile.`);
  if (cicp) {
    const cs = {1: 'srgb', 9: 'rec2020', 12: 'display-p3'}[cicp[0]], tf = {8: 'linear', 13: 'srgb', 16: 'pq', 18: 'hlg'}[cicp[1]];
    if (!cs || !tf || cicp[2] !== 0 || cicp[3] !== 1) throw unsupported(`cICP ${Array.from(cicp).join(', ')}`);
    description.colorSpace = cs; description.transferFunction = tf;
  } else if (iccp) {
    const nul = iccp.indexOf(0);
    if (nul > 0 && nul + 2 < iccp.length && iccp[nul + 1] === 0) {
      try {
        const icc = new Uint8Array(inflateSync(iccp.subarray(nul + 2), {maxOutputLength: 16 * 1024 * 1024}));
        if (icc.length >= 132) description.icc = icc;
      } catch {}
    }
  } else if (!srgb) {
    const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 0.002);
    if (chrm) {
      const vals = Array.from({length: 8}, (_, i) => chrm.readUInt32BE(i * 4) / 100000);
      if (near(vals, [0.3127, 0.329, 0.68, 0.32, 0.265, 0.69, 0.15, 0.06])) description.colorSpace = 'display-p3';
      else if (!near(vals, [0.3127, 0.329, 0.64, 0.33, 0.3, 0.6, 0.15, 0.06])) throw unsupported('other primaries (cHRM)');
    }
    if (gama) {
      const g = gama.readUInt32BE(0) / 100000;
      if (Math.abs(g - 1) < 0.001) description.transferFunction = 'linear';
      else if (Math.abs(g - 0.45455) > 0.005) throw unsupported(`gamma ${g} (gAMA)`);
    }
  }

  if (depth === 16) {
    const out = new Uint16Array(width * height * 4);
    const trns = transparency ? Array.from({length: transparency.length >> 1}, (_, i) => transparency.readUInt16BE(i * 2)) : null;
    let cursor = 0;
    for (const [x0, y0, dx, dy] of passes) {
      const w = Math.max(0, Math.ceil((width - x0) / dx)), h = Math.max(0, Math.ceil((height - y0) / dy));
      if (!w || !h) continue;
      const rowBytes = w * bpp;
      let prev = new Uint8Array(rowBytes), row = new Uint8Array(rowBytes);
      for (let y = 0; y < h; y++) {
        const f = raw[cursor++];
        if (f > 4) throw cliError('JXL_INPUT', `"${filePath}" contains an invalid PNG filter type.`, `re-save "${filePath}".`);
        for (let i = 0; i < rowBytes; i++) {
          const x = raw[cursor++], a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
          row[i] = (x + (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? paeth(a, b, c) : 0)) & 255;
        }
        const view = new DataView(row.buffer, row.byteOffset, row.byteLength);
        for (let x = 0; x < w; x++) {
          const src = x * bpp, dst = ((y0 + y * dy) * width + x0 + x * dx) * 4;
          const r = view.getUint16(src), g = channels < 3 ? r : view.getUint16(src + 2), b = channels < 3 ? r : view.getUint16(src + 4);
          out[dst] = r; out[dst + 1] = g; out[dst + 2] = b;
          out[dst + 3] = colour === 4 || colour === 6 ? view.getUint16(src + bpp - 2)
            : trns && r === trns[0] && (colour === 0 || (g === trns[1] && b === trns[2])) ? 0 : 65535;
        }
        [prev, row] = [row, prev];
      }
    }
    return {data: out, width, height, bitDepth: 16, sampleFormat: 'uint', ...description};
  }

  const rgba = new Uint8Array(width * height * 4);
  const scale = depth < 8 && colour !== 3 ? 255 / ((1 << depth) - 1) : 1;
  const sample = (row, index) => {
    if (depth === 8) return row[index];
    const bit = index * depth;
    return (row[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
  };
  let cursor = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const w = Math.max(0, Math.ceil((width - x0) / dx)), h = Math.max(0, Math.ceil((height - y0) / dy));
    if (!w || !h) continue;
    const rowBytes = Math.ceil((w * bitsPerPixel) / 8);
    let prev = new Uint8Array(rowBytes), row = new Uint8Array(rowBytes);
    for (let y = 0; y < h; y++) {
      const f = raw[cursor++];
      if (f > 4) throw cliError('JXL_INPUT', `"${filePath}" contains an invalid PNG filter type.`, `re-save "${filePath}".`);
      for (let i = 0; i < rowBytes; i++) {
        const x = raw[cursor++], a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        row[i] = (x + (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? paeth(a, b, c) : 0)) & 255;
      }
      for (let k = 0; k < w; k++) {
        const x = x0 + k * dx, dst = ((y0 + y * dy) * width + x) * 4;
        let r, g, b, a = 255;
        if (colour === 3) {
          const idx = sample(row, k);
          r = palette[idx * 3] ?? 0; g = palette[idx * 3 + 1] ?? 0; b = palette[idx * 3 + 2] ?? 0;
          a = transparency && idx < transparency.length ? transparency[idx] : 255;
        } else if (colour === 0) {
          const s = sample(row, k);
          r = g = b = Math.round(s * scale);
          if (transparency && transparency.length >= 2 && s === transparency.readUInt16BE(0)) a = 0;
        } else if (colour === 4) {
          r = g = b = row[k * 2]; a = row[k * 2 + 1];
        } else if (colour === 2) {
          r = row[k * 3]; g = row[k * 3 + 1]; b = row[k * 3 + 2];
          if (transparency && transparency.length >= 6 && r === transparency[1] && g === transparency[3] && b === transparency[5]) a = 0;
        } else {
          r = row[k * 4]; g = row[k * 4 + 1]; b = row[k * 4 + 2]; a = row[k * 4 + 3];
        }
        rgba[dst] = r; rgba[dst + 1] = g; rgba[dst + 2] = b; rgba[dst + 3] = a;
      }
      [prev, row] = [row, prev];
    }
  }
  return {data: rgba, width, height, ...description};
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
  if (colorSpace === 'srgb' && transferFunction === 'srgb') return [makePngChunk('sRGB', Buffer.from([0]))];
  if (CICP_PRIMARIES[colorSpace] && CICP_TRANSFER[transferFunction]) return [makePngChunk('cICP', Buffer.from([CICP_PRIMARIES[colorSpace], CICP_TRANSFER[transferFunction], 0, 1]))];
  throw cliError('JXL_UNSUPPORTED', 'PNG cannot state this picture\'s colors.', 'keep it as .jxl, or decode it with rapier-jxl/decode in code.');
}

export function writePngBytes(decoded) {
  let {width, height, data, bitDepth = 8} = decoded;
  if (data instanceof Float32Array) {
    const signal = !decoded.rgbaICC?.length && CICP_PRIMARIES[decoded.colorSpace] && (decoded.transferFunction === 'pq' || decoded.transferFunction === 'hlg');
    if (!signal || data.some(v => !(v >= 0 && v <= 1))) throw cliError('JXL_UNSUPPORTED', 'PNG cannot hold this picture\'s floating-point samples exactly.', 'keep it as .jxl, or decode it with rapier-jxl/decode in code.');
    data = Uint16Array.from(data, v => Math.round(v * 65535)); bitDepth = 16;
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
  return new Uint8Array(Buffer.concat([sig, makePngChunk('IHDR', ihdr), ...color, makePngChunk('IDAT', deflateSync(raw, {level: 6})), makePngChunk('IEND', Buffer.alloc(0))]));
}

async function jpegPixels(raw, displayIn) {
  const [{recompress}, {decode}] = await Promise.all([getJpeg(), getDecode()]);
  try { return await decode(await recompress(raw)); }
  catch (error) {
    throw cliError(error?.code || 'JXL_JPEG', `Could not read the JPEG "${displayIn}": ${error?.message || error}`,
      `convert it to PNG first, then run: npx rapier-jxl "${replaceExtension(displayIn, '.png')}"`);
  }
}

function lzwDecode(minCodeSize, data, pixelCount) {
  const clearCode = 1 << minCodeSize, eoiCode = clearCode + 1;
  const out = new Uint8Array(pixelCount);
  const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), stack = new Uint8Array(4096);
  let codeSize = minCodeSize + 1, nextCode = eoiCode + 1, codeMask = (1 << codeSize) - 1;
  let datum = 0, bits = 0, first = 0, oldCode = -1, top = 0, dst = 0, pos = 0;
  for (let i = 0; i < clearCode; i++) { prefix[i] = -1; suffix[i] = i; }
  while (dst < pixelCount) {
    while (bits < codeSize) {
      if (pos >= data.length) return out;
      datum |= data[pos++] << bits;
      bits += 8;
    }
    let code = datum & codeMask;
    datum >>>= codeSize;
    bits -= codeSize;
    if (code === clearCode) {
      codeSize = minCodeSize + 1;
      codeMask = (1 << codeSize) - 1;
      nextCode = eoiCode + 1;
      oldCode = -1;
      continue;
    }
    if (code === eoiCode) break;
    if (code > nextCode || oldCode === -1 && code >= clearCode) break;
    if (oldCode === -1) {
      out[dst++] = suffix[code];
      oldCode = code;
      first = code;
      continue;
    }
    const inCode = code;
    if (code >= nextCode) {
      stack[top++] = first;
      code = oldCode;
    }
    while (code >= clearCode) {
      stack[top++] = suffix[code];
      code = prefix[code];
    }
    first = suffix[code];
    stack[top++] = first;
    if (nextCode < 4096) {
      prefix[nextCode] = oldCode;
      suffix[nextCode] = first;
      nextCode++;
      if ((nextCode & codeMask) === 0 && nextCode < 4096) {
        codeSize++;
        codeMask = (1 << codeSize) - 1;
      }
    }
    oldCode = inCode;
    while (top > 0 && dst < pixelCount) out[dst++] = stack[--top];
  }
  return out;
}

export function readGifBytes(bytes, filePath = 'input.gif', maxPixels = 40000000, heldPixels = 1 << 28) {
  if (bytes.length < 13) throw cliError('JXL_INPUT', `"${filePath}" is truncated.`, `pass a complete GIF file.`);
  const width = bytes[6] | (bytes[7] << 8), height = bytes[8] | (bytes[9] << 8);
  dimensions(width, height, maxPixels);
  const packed = bytes[10];
  let pos = 13;
  let globalPalette = null;
  if (packed & 0x80) {
    const count = 1 << ((packed & 7) + 1);
    globalPalette = bytes.subarray(pos, pos + count * 3);
    pos += count * 3;
  }
  const readSubBlocks = () => {
    const chunks = [];
    while (pos < bytes.length) {
      const sz = bytes[pos++];
      if (!sz) break;
      chunks.push(bytes.subarray(pos, pos + sz));
      pos += sz;
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { merged.set(c, at); at += c.length; }
    return merged;
  };
  const canvas = new Uint8Array(width * height * 4);
  const frames = [];
  let delayMs = 100, transIdx = -1, disposal = 0, loops = 0;
  while (pos < bytes.length) {
    const block = bytes[pos++];
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = bytes[pos++];
      if (label === 0xf9) {
        const sz = bytes[pos++];
        const flags = bytes[pos];
        disposal = (flags >> 2) & 7;
        const hasTrans = flags & 1;
        const delayCs = bytes[pos + 1] | (bytes[pos + 2] << 8);
        delayMs = Math.max(10, (delayCs || 10) * 10);
        transIdx = hasTrans ? bytes[pos + 3] : -1;
        pos += sz + 1;
      } else if (label === 0xff) {
        const sub = readSubBlocks();
        if (sub.length >= 14 && sub[11] === 1) loops = sub[12] | (sub[13] << 8);
      } else {
        readSubBlocks();
      }
    } else if (block === 0x2c) {
      const left = bytes[pos] | (bytes[pos + 1] << 8), top = bytes[pos + 2] | (bytes[pos + 3] << 8);
      const fw = bytes[pos + 4] | (bytes[pos + 5] << 8), fh = bytes[pos + 6] | (bytes[pos + 7] << 8);
      const fpack = bytes[pos + 8];
      pos += 9;
      let pal = globalPalette;
      if (fpack & 0x80) {
        const count = 1 << ((fpack & 7) + 1);
        pal = bytes.subarray(pos, pos + count * 3);
        pos += count * 3;
      }
      if (!pal) throw cliError('JXL_INPUT', `"${filePath}" GIF frame has no color table.`, `re-export "${filePath}".`);
      if (!fw || !fh || fw * fh > maxPixels) throw cliError('JXL_DIMENSIONS', `"${filePath}" has a ${fw} x ${fh} GIF frame.`, `re-export "${filePath}".`);
      const minCodeSize = bytes[pos++];
      if (!(minCodeSize >= 2 && minCodeSize <= 8)) throw cliError('JXL_INPUT', `"${filePath}" is not a valid GIF (LZW code size ${minCodeSize}).`, `re-export "${filePath}".`);
      if ((frames.length + 1) * Math.max(width * height, 65536) > heldPixels) throw cliError('JXL_LIMIT', `"${filePath}" has more frames than fit in 1 GiB at ${width} x ${height}.`, `shorten or resize it first.`);
      const lzwData = readSubBlocks();
      const indices = lzwDecode(minCodeSize, lzwData, fw * fh);
      const prevCanvas = disposal === 3 ? canvas.slice() : null;
      const interlaced = !!(fpack & 0x40);
      const rowOrder = [];
      if (interlaced) {
        for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
          for (let y = start; y < fh; y += step) rowOrder.push(y);
        }
      }
      for (let sy = 0; sy < fh; sy++) {
        const dy = top + (interlaced ? rowOrder[sy] : sy);
        if (dy >= height) continue;
        for (let sx = 0; sx < fw; sx++) {
          const dx = left + sx;
          if (dx >= width) continue;
          const idx = indices[sy * fw + sx];
          if (idx === transIdx) continue;
          const dst = (dy * width + dx) * 4;
          canvas[dst] = pal[idx * 3] ?? 0;
          canvas[dst + 1] = pal[idx * 3 + 1] ?? 0;
          canvas[dst + 2] = pal[idx * 3 + 2] ?? 0;
          canvas[dst + 3] = 255;
        }
      }
      frames.push({data: canvas.slice(), duration: delayMs});
      if (disposal === 2) {
        for (let sy = 0; sy < fh; sy++) {
          const dy = top + sy;
          if (dy < height) canvas.fill(0, (dy * width + left) * 4, (dy * width + Math.min(width, left + fw)) * 4);
        }
      } else if (disposal === 3 && prevCanvas) {
        canvas.set(prevCanvas);
      }
      delayMs = 100; transIdx = -1; disposal = 0;
    } else {
      break;
    }
  }
  if (!frames.length) throw cliError('JXL_INPUT', `"${filePath}" contains no GIF frames.`, `pass a valid GIF image.`);
  if (frames.length === 1) return {kind: 'still', picture: {data: frames[0].data, width, height}};
  return {kind: 'animation', animation: {width, height, loops, frames}};
}

async function decodeViaRuntime(bytes, format, filePath, maxPixels = 40000000) {
  const mime = format === 'webp' ? 'image/webp' : format === 'avif' ? 'image/avif' : `image/${format}`;
  if (typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function') {
    let bitmap;
    try {
      bitmap = await createImageBitmap(new Blob([bytes], {type: mime}));
    } catch (cause) {
      throw cliError('JXL_INPUT', `Could not decode ${format.toUpperCase()} file "${filePath}": ${cause?.message || cause}.`,
        `check that "${filePath}" is a valid ${format.toUpperCase()} image.`);
    }
    try {
      const {width, height} = bitmap;
      dimensions(width, height, maxPixels);
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d', {willReadFrequently: true});
      if (!ctx) throw new Error('No 2D context');
      ctx.drawImage(bitmap, 0, 0);
      const imageData = ctx.getImageData(0, 0, width, height);
      return {data: new Uint8Array(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength), width, height};
    } finally {
      bitmap.close?.();
    }
  }
  const stem = basename(filePath, extname(filePath)) || 'image';
  throw cliError('JXL_PLATFORM',
    `This runtime does not decode ${format.toUpperCase()} natively ("${filePath}").`,
    `convert "${filePath}" to PNG or JPEG first (for example: ffmpeg -i "${filePath}" "${stem}.png"), then run: npx rapier-jxl "${stem}.png"`);
}

async function encodeUnderMaxBytes(encodeFn, picture, {maxBytes, quality, effort, lossless, filePath}) {
  if (lossless || quality === 100) {
    const exact = await encodeFn(picture, {fidelity: 'exact', effort});
    if (exact.byteLength <= maxBytes) return exact;
    throw cliError('JXL_TARGET',
      `Lossless output for "${filePath}" is ${formatBytes(exact.byteLength)} (${exact.byteLength} B), which exceeds --max-bytes ${maxBytes}.`,
      `remove --lossless to allow lossy compression under ${formatBytes(maxBytes)}, or raise --max-bytes to at least ${exact.byteLength}.`);
  }
  const ceiling = quality !== undefined ? Math.min(99, Math.round(quality)) : 90;
  const atCeiling = await encodeFn(picture, {fidelity: {quality: ceiling}, effort});
  if (atCeiling.byteLength <= maxBytes) return atCeiling;

  const atMin = await encodeFn(picture, {fidelity: {quality: 1}, effort});
  if (atMin.byteLength > maxBytes) {
    throw cliError('JXL_TARGET',
      `Cannot fit "${filePath}" under ${formatBytes(maxBytes)} (${maxBytes} B); smallest output at --quality 1 is ${formatBytes(atMin.byteLength)} (${atMin.byteLength} B).`,
      `raise --max-bytes to at least ${atMin.byteLength}, or resize "${filePath}" to smaller dimensions before encoding.`);
  }
  let bestBytes = atMin;
  let lo = 2, hi = ceiling - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = await encodeFn(picture, {fidelity: {quality: mid}, effort});
    if (candidate.byteLength <= maxBytes) {
      bestBytes = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return bestBytes;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif']);

async function collectDirectoryImages(rootDir, currentDir = rootDir, out = []) {
  const entries = (await readdir(currentDir, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await collectDirectoryImages(rootDir, fullPath, out);
    } else if (entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
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
  const fidelity = options.lossless || options.quality === 100 ? 'exact' : {quality: options.quality ?? 90};
  const pixels = (picture, encodeFn = runner.encode) => options.maxBytes === undefined ? encodeFn(picture, {fidelity, effort: options.effort})
    : encodeUnderMaxBytes(encodeFn, picture, {maxBytes: options.maxBytes, quality: options.quality, effort: options.effort, lossless: options.lossless, filePath: displayIn});
  if (format === 'jpeg') {
    if (options.lossless || options.quality === undefined || options.quality === 100) {
      const {recompress} = await getJpeg();
      let exact = null;
      try { exact = await recompress(raw, {effort: options.effort}); } catch (error) { if (error?.code !== 'JXL_JPEG') throw error; }
      if (exact && (options.maxBytes === undefined || exact.byteLength <= options.maxBytes)) return {bytes: exact, note: 'exact JPEG'};
    }
    return {bytes: await pixels(await jpegPixels(raw, displayIn))};
  }
  if (format === 'png') return {bytes: await pixels(readPngBytes(raw, displayIn))};
  if (format === 'gif') {
    const decoded = readGifBytes(raw, displayIn);
    if (decoded.kind !== 'animation') return {bytes: await pixels(decoded.picture)};
    const {encode} = await getAnimation();
    return {bytes: await pixels(decoded.animation, encode), note: 'animation'};
  }
  return {bytes: await pixels(await decodeViaRuntime(raw, format, displayIn))};
}

async function decodeFile(raw, displayIn, outputPath, named) {
  if (extname(outputPath).toLowerCase() !== '.png') {
    const {restore} = await getJpeg();
    try { return {bytes: await restore(raw), note: 'exact JPEG', outputPath}; }
    catch (error) {
      if (error?.code !== 'JXL_RECONSTRUCTION') throw error;
      if (named) throw cliError('JXL_RECONSTRUCTION', `"${displayIn}" was not made from a JPEG, so it has no JPEG to restore.`,
        `write a PNG instead: npx rapier-jxl "${displayIn}" --out "${replaceExtension(displayIn, '.png')}"`);
      outputPath = replaceExtension(outputPath, '.png');
    }
  }
  const {decode} = await getDecode();
  return {bytes: writePngBytes(await decode(raw)), note: 'decoded', outputPath};
}

async function writeWhole(path, bytes, noClobber) {
  await mkdir(dirname(path), {recursive: true});
  const temporary = await mkdtemp(path + '.partial-'), file = join(temporary, 'image');
  try { await writeFile(file, bytes); await (noClobber ? link(file, path) : rename(file, path)); }
  finally { await rm(temporary, {recursive: true, force: true}); }
}

async function processSingleTask(task, options, runner) {
  const {inputPath, displayIn, named} = task;
  const raw = new Uint8Array(await readFile(inputPath));
  if (!raw.byteLength) throw cliError('JXL_INPUT', `"${displayIn}" is empty.`, 'pass an image file.');
  const format = detectFormat(raw, inputPath);
  if (!format) throw cliError('JXL_INPUT', `"${displayIn}" is not a PNG, JPEG, GIF, WebP, AVIF or JPEG XL file.`, 'pass one of those, for example: npx rapier-jxl photo.png');
  const made = format === 'jxl' ? await decodeFile(raw, displayIn, task.outputPath, named) : {...await encodeFile(raw, format, displayIn, options, runner), outputPath: task.outputPath};
  if (await samePath(made.outputPath, inputPath)) throw cliError('JXL_OPTIONS', `The output "${displayIn}" is the input itself.`, 'pass another --out path.');
  try { await writeWhole(made.outputPath, made.bytes, !named); }
  catch (error) {
    if (named || error.code !== 'EEXIST') throw error;
    const existing = await readFile(made.outputPath).catch(() => null);
    const shownPath = replaceExtension(task.displayOut, extname(made.outputPath));
    if (!existing || !Buffer.from(made.bytes).equals(existing)) throw cliError('JXL_OPTIONS', `"${shownPath}" already exists.`,
      `name another file: npx rapier-jxl "${displayIn}" --out "${replaceExtension(shownPath, '')}-${format === 'jxl' && extname(made.outputPath) === '.png' ? 'decoded' : 'restored'}${extname(made.outputPath)}"`);
  }
  const shown = made.outputPath === task.outputPath ? task.displayOut : replaceExtension(task.displayOut, extname(made.outputPath));
  return {inputPath, outputPath: made.outputPath, inputBytes: raw.byteLength, outputBytes: made.bytes.byteLength,
    line: formatLine(displayIn, shown, raw.byteLength, made.bytes.byteLength, made.note)};
}

async function samePath(a, b) {
  if (resolve(a) === resolve(b)) return true;
  try { return await realpath(a) === await realpath(b); } catch { return false; }
}

function formatFriendlyError(error) {
  if (error?.fix) return `rapier-jxl: ${error.message}`;
  const code = error?.code, msg = String(error?.message || error).replace(/\.?$/, '.');
  const fix = code === 'JXL_WASM' ? 'run on Node 20.16 or later without --jitless.'
    : code === 'JXL_DIMENSIONS' ? 'resize the picture to at most 40 megapixels.'
    : code === 'JXL_MEMORY' || code === 'JXL_LIMIT' ? 'lower --jobs, or pass a smaller picture.'
    : 'run npx rapier-jxl --help for examples.';
  return `rapier-jxl: ${msg} Fix: ${fix}`;
}

export async function runCli(argv = process.argv.slice(2), io = {}) {
  const cwd = io.cwd ? resolve(io.cwd) : process.cwd();
  const stdout = io.stdout ?? (line => process.stdout.write(line + '\n'));
  const stderr = io.stderr ?? (line => process.stderr.write(line + '\n'));
  let parsed;
  try { parsed = parseCliArgs(argv); } catch (error) { stderr(formatFriendlyError(error)); return {exitCode: 1, files: []}; }
  const {inputs, options} = parsed;
  if (options.help) { stdout(HELP_TEXT.trimEnd()); return {exitCode: 0, files: []}; }
  if (options.version) { stdout(VERSION); return {exitCode: 0, files: []}; }
  if (!inputs.length) { stderr(formatFriendlyError(cliError('JXL_OPTIONS', 'No picture or folder given.', 'pass one, for example: npx rapier-jxl photo.png'))); return {exitCode: 1, files: []}; }

  let codecQueue = null;
  try {
    const found = [];
    for (const rawInput of inputs) {
      const fullInput = resolve(cwd, rawInput);
      let info;
      try { info = await stat(fullInput); } catch { throw cliError('JXL_INPUT', `"${rawInput}" does not exist.`, 'check the path.'); }
      found.push({rawInput, fullInput, isDirectory: info.isDirectory()});
    }
    const many = found.length > 1 || found[0].isDirectory;
    const out = options.out === undefined ? null : resolve(cwd, options.out);
    let outIsDir = many || /[\\/]$/.test(options.out ?? '');
    if (out !== null) {
      const outInfo = await stat(out).catch(() => null);
      if (outInfo?.isDirectory()) outIsDir = true;
      if (many && outInfo?.isFile()) throw cliError('JXL_OPTIONS', `--out "${options.out}" is a file, but several pictures were given.`, 'pass a folder, for example: --out dist/');
    }
    const tasks = [], show = path => relative(cwd, path) || basename(path);
    for (const {rawInput, fullInput, isDirectory} of found) {
      if (isDirectory) {
        const items = await collectDirectoryImages(fullInput);
        if (!items.length) throw cliError('JXL_INPUT', `"${rawInput}" holds no PNG, JPEG, GIF, WebP or AVIF files.`, 'pass a folder of pictures, or a picture.');
        for (const item of items) {
          const outputPath = replaceExtension(out ? join(out, item.relPath) : item.inputPath, '.jxl');
          tasks.push({inputPath: item.inputPath, outputPath, displayIn: show(item.inputPath), displayOut: show(outputPath), named: false});
        }
      } else {
        const ext = extname(fullInput).toLowerCase() === '.jxl' ? '.jpg' : '.jxl';
        const outputPath = out ? (outIsDir ? join(out, replaceExtension(basename(fullInput), ext)) : out) : replaceExtension(fullInput, ext);
        tasks.push({inputPath: fullInput, outputPath, displayIn: show(fullInput), displayOut: show(outputPath), named: out !== null && !outIsDir});
      }
    }
    const seen = new Map();
    for (const task of tasks) {
      const key = task.outputPath.toLowerCase(), other = seen.get(key);
      if (other) throw cliError('JXL_OPTIONS', `"${other.displayIn}" and "${task.displayIn}" would both be written to "${task.displayOut}".`,
        `rename one of them, or convert them one at a time with --out.`);
      seen.set(key, task);
    }

    let runner;
    if (options.jobs > 0) {
      const {createCodec} = await getCodec();
      codecQueue = createCodec({module: 'rapier-jxl', helpers: {count: options.jobs, memoryBytes: Math.max(1, options.jobs) * 512 * 1024 * 1024}});
      runner = {encode: (picture, encodeOptions) => codecQueue.encode(picture, encodeOptions)};
    } else runner = {encode: async (picture, encodeOptions) => (await getStill()).encode(picture, encodeOptions)};

    const results = [];
    let next = 0, failed = 0;
    await Promise.all(Array.from({length: options.jobs > 0 ? Math.min(tasks.length, options.jobs) : 1}, async () => {
      while (next < tasks.length) {
        const task = tasks[next++];
        try { const result = await processSingleTask(task, options, runner); results.push(result); stdout(result.line); }
        catch (error) { failed++; stderr(tasks.length > 1 ? `${task.displayIn}: ${formatFriendlyError(error)}` : formatFriendlyError(error)); }
      }
    }));
    if (tasks.length > 1) {
      const totalIn = results.reduce((n, r) => n + r.inputBytes, 0), totalOut = results.reduce((n, r) => n + r.outputBytes, 0);
      const saved = totalIn - totalOut, pct = totalIn > 0 ? Math.abs(saved / totalIn) * 100 : 0;
      stdout(`${results.length} of ${tasks.length} files: ${formatBytes(totalIn)} -> ${formatBytes(totalOut)} (${saved >= 0 ? '-' : '+'}${pct.toFixed(1)}%)${failed ? `, ${failed} failed` : ''}`);
    }
    return {exitCode: failed ? 1 : 0, files: results};
  } catch (error) {
    stderr(formatFriendlyError(error));
    return {exitCode: 1, files: []};
  } finally {
    if (codecQueue) await codecQueue.close().catch(() => {});
  }
}

const isMain = await (async () => {
  if (!process.argv[1]) return false;
  try { return await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  const {exitCode} = await runCli(process.argv.slice(2));
  if (exitCode !== 0) process.exitCode = exitCode;
}
