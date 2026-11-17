// SPDX-License-Identifier: MIT
import {LIMITS} from './limits.mjs';
import {ZIGZAG, jpegError, parseJPEG, profileSpace, profileIntent, namedEncoding} from './jfif.mjs';
import {inspectICC} from './icc-profile.mjs';
import {exifOrientation} from './exif-orientation.mjs';
import {jpegYCbCr} from './jpeg-color.mjs';
import {jpegKernels} from './jpeg-kernels.mjs';
import {orientSamples} from './sample-transforms.mjs';
import {prepareKernels, ensureKernels} from './kernels.mjs';
import {wasmRequired} from './capture-wasm-error.mjs';
import {check, dimensions} from './v7/primitives.mjs';
import {sliceBytes} from './step-journal.mjs';

export const JPEG_PIXELS_SYMBOL = Symbol.for('rapier-jxl.jpeg.pixels');
export const JPEG_GEOMETRY_SYMBOL = Symbol.for('rapier-jxl.jpeg.geometry');

const ICC_CACHE = new Map();
function iccHash(bytes) {
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619);
  return `${bytes.length}:${h >>> 0}`;
}

function buildHuffman(counts, symbols) {
  const lookup = new Uint16Array(65536);
  let code = 0, k = 0;
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < counts[length - 1]; i++) {
      const symbol = symbols[k++], start = code << (16 - length), n = 1 << (16 - length);
      if (start + n >= 65536) throw jpegError('Huffman table');
      lookup.fill((length << 8) | symbol, start, start + n);
      code++;
    }
    code <<= 1;
  }
  return lookup;
}

function validateHuffman(counts) {
  let code = 0;
  for (let length = 1; length <= 16; length++) {
    const n = counts[length - 1];
    if (n && (code + n) * (1 << (16 - length)) >= 65536) throw jpegError('Huffman table');
    code = (code + n) * 2;
  }
}

export function chooseJpegIdctScale(trueWidth, trueHeight, outputs) {
  if (!Array.isArray(outputs) || !outputs.length) return 8;
  let maxW = 0, maxH = 0;
  for (const req of outputs) {
    if (!req || (req.width === undefined && req.height === undefined)) return 8;
    const w = req.width ?? Math.max(1, Math.round(req.height * trueWidth / trueHeight));
    const h = req.height ?? Math.max(1, Math.round(req.width * trueHeight / trueWidth));
    if (w > maxW) maxW = w;
    if (h > maxH) maxH = h;
  }
  if (maxW >= trueWidth && maxH >= trueHeight) return 8;
  for (const [n, guard] of [[1, 4.0], [2, 2.0], [4, 1.25], [6, 1.15]]) {
    const decW = Math.max(1, Math.ceil(trueWidth * n / 8));
    const decH = Math.max(1, Math.ceil(trueHeight * n / 8));
    if (decW >= maxW * guard && decH >= maxH * guard) return n;
  }
  return 8;
}

function makeSubsamplingPlan(width, height, components, ycbcr, scale) {
  const count = components.length;
  const outW = Math.max(1, Math.ceil(width * scale / 8));
  const outH = Math.max(1, Math.ceil(height * scale / 8));
  const hmax = Math.max(...components.map(c => c.h));
  const vmax = Math.max(...components.map(c => c.v));
  const mcusX = Math.ceil(width / (8 * hmax));
  const mcusY = Math.ceil(height / (8 * vmax));
  if (count === 1) {
    if (components[0].h !== hmax || components[0].v !== vmax) return null;
    return {
      scale, outW, outH, mcusX, mcusY, mxY: scale, myY: scale, mxC: scale, myC: scale,
      mode: 0, clampW: 0, clampH: 0, yBias: 128, cBias: 0,
    };
  }
  if (count !== 3) return null;
  const [c0, c1, c2] = components;
  if (c1.h !== c2.h || c1.v !== c2.v || c0.h !== hmax || c0.v !== vmax) return null;
  const rx = c0.h / c1.h, ry = c0.v / c1.v;
  if (![1, 2].includes(rx) || ![1, 2].includes(ry)) return null;
  if (!ycbcr && (rx !== 1 || ry !== 1)) return null;

  let mxC = scale, myC = scale, mode = ycbcr ? 1 : 5;
  if (rx === 2 && ry === 2) {
    if (scale <= 4) { mxC = scale * 2; myC = scale * 2; mode = 1; }
    else mode = 2;
  } else if (rx === 2 && ry === 1) {
    if (scale <= 4) { mxC = scale * 2; myC = scale; mode = 1; }
    else mode = 3;
  } else if (rx === 1 && ry === 2) {
    if (scale <= 4) { mxC = scale; myC = scale * 2; mode = 1; }
    else mode = 4;
  }
  const clampW = Math.max(0, Math.ceil(Math.ceil(width / rx) * mxC / 8) - 1);
  const clampH = Math.max(0, Math.ceil(Math.ceil(height / ry) * myC / 8) - 1);
  return {
    scale, outW, outH, mcusX, mcusY, mxY: scale, myY: scale, mxC, myC,
    mode, clampW, clampH, yBias: 128, cBias: ycbcr ? 0 : 128,
  };
}

function resolveIcc(iccParts, count, componentCount, isoGain) {
  if (!count) return {colorSpace: 'srgb', icc: undefined};
  const parts = [];
  for (let i = 1; i <= count; i++) {
    if (!iccParts[i]) throw jpegError('ICC profile: incomplete');
    parts.push(iccParts[i]);
  }
  const original = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  for (let i = 0, at = 0; i < parts.length; at += parts[i].length, i++) original.set(parts[i], at);
  const expected = componentCount === 1 ? 'gray' : 'rgb';
  const declared = original.length >= 4 ? ((original[0] << 24) | (original[1] << 16) | (original[2] << 8) | original[3]) >>> 0 : 0;
  const color = declared >= 132 && declared < original.length ? sliceBytes(original, 0, declared) : original;
  const cacheKey = `${componentCount}:${isoGain ? 1 : 0}:${iccHash(color)}`;
  const hit = ICC_CACHE.get(cacheKey);
  if (hit && !hit.icc) return hit;
  try {
    const channels = inspectICC(color, undefined, isoGain && expected === 'gray' ? undefined : expected);
    if (channels !== componentCount) return {colorSpace: 'srgb', icc: undefined};
    const named = profileSpace(color);
    const out = named ? {colorSpace: named, icc: undefined, renderingIntent: profileIntent(color)} : {colorSpace: 'srgb', icc: color};
    if (named && ICC_CACHE.size < 64) ICC_CACHE.set(cacheKey, out);
    return out;
  } catch (error) {
    if (error.code === 'JXL_INPUT') throw jpegError('ICC profile: ' + error.message);
    throw error;
  }
}

function finishAfterScan(bytes, pos, total, restartInterval, orientation) {
  if (bytes[pos] === 0xFF && bytes[pos + 1] >= 0xD0 && bytes[pos + 1] <= 0xD7) {
    if (!restartInterval || total % restartInterval || bytes[pos + 1] !== 0xD0 + ((total / restartInterval - 1) & 7))
      return null;
    pos += 2;
    while (pos + 1 < bytes.length && bytes[pos] === 0xFF && bytes[pos + 1] === 0xFF) pos++;
  }
  if (pos < bytes.length && !(bytes[pos] === 0xFF && pos + 1 < bytes.length && bytes[pos + 1] !== 0 && bytes[pos + 1] !== 0xFF))
    return null;
  let markerCount = 0;
  while (pos < bytes.length) {
    if (bytes[pos] !== 0xFF) return null;
    while (bytes[pos] === 0xFF) pos++;
    const marker = bytes[pos++];
    if (++markerCount > 16384) return null;
    if (marker === 0xD9) return {orientation: orientation ?? 1};
    if (marker === 0xDA || marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD7)) return null;
    if (marker === 0x01) continue;
    if (pos + 2 > bytes.length) return null;
    const len = (bytes[pos] << 8) | bytes[pos + 1], seg = pos + 2, end = pos + len;
    if (len < 2 || end > bytes.length) return null;
    if (marker === 0xE1 && end - seg >= 6 && bytes[seg] === 0x45 && bytes[seg + 1] === 0x78 && bytes[seg + 2] === 0x69 && bytes[seg + 3] === 0x66 && bytes[seg + 4] === 0)
      orientation ??= exifOrientation(bytes, seg + 6, end);
    else if (marker === 0xE2 && len >= 16 && bytes[seg] === 0x49 && bytes[seg + 1] === 0x43 && bytes[seg + 2] === 0x43)
      return null;
    pos = end;
  }
  return {orientation: orientation ?? 1};
}

function trySequentialScaled(bytes, maxPixels, outputs, onBandOut) {
  if (!(bytes.length > 4) || bytes[0] !== 0xFF || bytes[1] !== 0xD8) throw jpegError('invalid signature');
  const quant = [], huffman = [[], []], badDC = new Set(), icc = {count: 0, parts: []};
  const lookup = (kind, slot) => { const t = huffman[kind][slot]; return t && (t.lookup ??= buildHuffman(t.counts, t.symbols)); };
  const u16 = at => (bytes[at] << 8) | bytes[at + 1];
  const sig = (at, s) => { for (let i = 0; i < s.length; i++) if (bytes[at + i] !== s.charCodeAt(i)) return false; return true; };
  let frame = null, restartInterval = 0, adobeTransform = -1, jfif = false, orientation = null, isoGain = false, pos = 2;
  let markerCount = 0, huffmanCount = 0;
  const most = Math.min(LIMITS.pixels, maxPixels ?? LIMITS.pixels);

  for (;;) {
    if (pos >= bytes.length) throw jpegError('truncated');
    if (bytes[pos] !== 0xFF) throw jpegError('marker');
    while (bytes[pos] === 0xFF) pos++;
    const marker = bytes[pos++];
    if (++markerCount > 16384) throw jpegError('markers: max 16384');
    if (marker === 0xD9) throw jpegError('missing frame');
    if (marker === 0xD8) throw jpegError('duplicate SOI');
    if (marker >= 0xD0 && marker <= 0xD7) throw jpegError('restart outside scan');
    if (marker === 0x01) continue;
    if (pos + 2 > bytes.length) throw jpegError('truncated');
    const length = u16(pos), segment = pos + 2, end = pos + length;
    if (length < 2 || end > bytes.length) throw jpegError('segment length');
    pos = end;

    if (marker === 0xDB) {
      for (let at = segment; at < end;) {
        const pq = bytes[at] >> 4, tq = bytes[at] & 15;
        if (pq > 1 || tq > 3 || at + 1 + (pq ? 128 : 64) > end) throw jpegError('quantization table');
        at++;
        const table = new Int32Array(64);
        for (let k = 0; k < 64; k++) { table[ZIGZAG[k]] = pq ? u16(at) : bytes[at]; at += pq ? 2 : 1; if (!table[ZIGZAG[k]]) throw jpegError('zero quantization step'); }
        quant[tq] = table;
      }
    } else if (marker === 0xC4) {
      for (let at = segment; at < end;) {
        if (++huffmanCount > 89) throw jpegError('Huffman tables: max 89');
        const tc = bytes[at] >> 4, th = bytes[at] & 15;
        if (tc > 1 || th > 3 || at + 17 > end) throw jpegError('Huffman table');
        at++;
        const counts = bytes.subarray(at, at + 16);
        let total = 0;
        for (const c of counts) total += c;
        if (total > 256 || at + 16 + total > end) throw jpegError('Huffman table');
        const symbols = bytes.subarray(at + 16, at + 16 + total);
        validateHuffman(counts);
        huffman[tc][th] = {counts, symbols, lookup: null};
        if (tc === 0) { if (symbols.some(s => s > 15)) badDC.add(th); else badDC.delete(th); }
        at += 16 + total;
      }
    } else if (marker === 0xC0 || marker === 0xC1) {
      if (frame) throw jpegError('multiple frames');
      if (end - segment < 6) throw jpegError('frame header');
      if (bytes[segment] !== 8) throw jpegError('bit depth: 8');
      const height = u16(segment + 1), width = u16(segment + 3), count = bytes[segment + 5];
      if (!width || !height) throw jpegError('DNL height');
      if (count === 4) return null;
      if (count !== 1 && count !== 3) throw jpegError('components: 1 or 3');
      if (end - segment < 6 + count * 3) throw jpegError('frame header');
      if (width > LIMITS.edge || height > LIMITS.edge) throw jpegError('side: max ' + LIMITS.edge, 'JXL_DIMENSIONS');
      if (width * height > most) throw jpegError('pixels: max ' + most, 'JXL_DIMENSIONS');
      const components = [];
      for (let i = 0, at = segment + 6; i < count; i++, at += 3) {
        const h = bytes[at + 1] >> 4, v = bytes[at + 1] & 15, tq = bytes[at + 2];
        if (h < 1 || h > 4 || v < 1 || v > 4) throw jpegError('sampling factors');
        if (tq > 3) throw jpegError('quantization table');
        if (components.some(c => c.id === bytes[at])) throw jpegError('duplicate component id');
        components.push({id: bytes[at], h, v, tq, pred: 0});
      }
      const hmax = Math.max(...components.map(c => c.h)), vmax = Math.max(...components.map(c => c.v));
      const mcusX = Math.ceil(width / (8 * hmax)), mcusY = Math.ceil(height / (8 * vmax));
      for (const c of components) {
        c.blocksW = Math.ceil(Math.ceil(width * c.h / hmax) / 8);
        c.blocksH = Math.ceil(Math.ceil(height * c.v / vmax) / 8);
        c.stride = mcusX * c.h; c.rows = mcusY * c.v;
      }
      frame = {width, height, components, hmax, vmax, mcusX, mcusY};
    } else if (marker === 0xC2) {
      return null;
    } else if (marker === 0xC3 || (marker >= 0xC5 && marker <= 0xC7) || (marker >= 0xC9 && marker <= 0xCB) || (marker >= 0xCD && marker <= 0xCF)) {
      throw jpegError('coding: baseline or progressive');
    } else if (marker === 0xDD) {
      if (length < 4) throw jpegError('segment length');
      restartInterval = u16(segment);
    } else if (marker === 0xDC) {
      throw jpegError('DNL marker');
    } else if (marker === 0xDA) {
      if (!frame) throw jpegError('scan before frame');
      const n = bytes[segment];
      if (n !== frame.components.length || segment + 1 + n * 2 + 3 > end) return null;
      const scan = [];
      let at = segment + 1;
      for (let i = 0; i < n; i++, at += 2) {
        const component = frame.components[i];
        if (component.id !== bytes[at]) return null;
        component.quant = quant[component.tq];
        if (!component.quant) throw jpegError('missing quantization table');
        const td = bytes[at + 1] >> 4, ta = bytes[at + 1] & 15;
        if (td > 3 || ta > 3) throw jpegError('table selector: 0-3');
        if (badDC.has(td)) throw jpegError('Huffman table');
        scan.push({component, dc: lookup(0, td), ac: lookup(1, ta)});
      }
      if (n > 1 && scan.reduce((sum, s) => sum + s.component.h * s.component.v, 0) > 10) throw jpegError('sampling factors');
      const ss = bytes[at], se = bytes[at + 1], ah = bytes[at + 2] >> 4, al = bytes[at + 2] & 15;
      if (ss !== 0 || se !== 63 || ah !== 0 || al !== 0) throw jpegError('spectral selection');
      if ((bytes.length - end) * 8 < frame.components.reduce((sum, c) => sum + c.blocksW * c.blocksH, 0)) throw jpegError('scan: incomplete');

      const prelimOrient = orientation ?? 1;
      if (onBandOut && prelimOrient > 1) return null;
      const transpose = prelimOrient >= 5;
      const prelimTrueW = transpose ? frame.height : frame.width;
      const prelimTrueH = transpose ? frame.width : frame.height;
      const scale = typeof outputs === 'number' ? outputs : chooseJpegIdctScale(prelimTrueW, prelimTrueH, outputs);
      const ycbcr = jpegYCbCr(frame.components, jfif, adobeTransform);
      const plan = makeSubsamplingPlan(frame.width, frame.height, frame.components, ycbcr, scale);
      if (!plan) return null;
      const kernels = jpegKernels();
      if (!kernels?.scaledDecode) return null;

      let rgba = null;
      const bandSink = onBandOut
        ? (y, rows, view) => onBandOut(y, rows, view, plan)
        : (y, rows, view) => {
            rgba ??= new Uint8Array(plan.outW * plan.outH * 4);
            rgba.set(view, y * plan.outW * 4);
          };
      const decoded = kernels.scaledDecode(bytes, end, frame, scan, restartInterval, ZIGZAG, plan, bandSink, prelimOrient);
      if (!decoded) return null;
      const total = n === 1 ? frame.components[0].blocksW * frame.components[0].blocksH : frame.mcusX * frame.mcusY;
      const tail = finishAfterScan(bytes, decoded.pos, total, restartInterval, orientation);
      if (!tail) return null;
      if (tail.orientation !== prelimOrient && (scale < 8 || decoded.oriented)) return null;
      const color = resolveIcc(icc.parts, icc.count, frame.components.length, isoGain);
      const alreadyOriented = !!decoded.oriented;
      return {
        data: decoded.oriented ?? rgba,
        width: alreadyOriented && transpose ? plan.outH : plan.outW,
        height: alreadyOriented && transpose ? plan.outW : plan.outH,
        origWidth: frame.width, origHeight: frame.height,
        orientation: tail.orientation, alreadyOriented,
        colorSpace: color.colorSpace, icc: color.icc, renderingIntent: color.renderingIntent, scale,
      };
    } else if (marker === 0xE0) {
      if (sig(segment, 'JFIF')) jfif = true;
    } else if (marker === 0xE1) {
      if (sig(segment, 'Exif') && bytes[segment + 4] === 0) orientation ??= exifOrientation(bytes, segment + 6, end);
    } else if (marker === 0xE2) {
      if (length >= 16 && sig(segment, 'ICC_PROFILE\0')) {
        const seq = bytes[segment + 12], count = bytes[segment + 13];
        if (!seq || !count || seq > count || (icc.count && icc.count !== count) || icc.parts[seq]) throw jpegError('ICC profile: incomplete');
        icc.count = count; icc.parts[seq] = sliceBytes(bytes, segment + 14, end);
      } else if (length >= 35 && sig(segment, 'urn:iso:std:iso:ts:21496:-1\0')) isoGain = true;
    } else if (marker === 0xEE) {
      if (length >= 14 && sig(segment, 'Adobe')) adobeTransform = bytes[segment + 11];
    }
  }
}

export async function decodeJpegPixels(bytes, {maxPixels, signal, outputs, scale: forcedScale} = {}) {
  check(signal);
  if (!await prepareKernels() || !ensureKernels() || !jpegKernels()) throw wasmRequired();
  check(signal);
  bytes = sliceBytes(bytes);

  let decoded = trySequentialScaled(bytes, maxPixels, forcedScale ?? outputs, null);
  if (!decoded) {
    const parsed = parseJPEG(bytes, false, {maxPixels: maxPixels ?? LIMITS.pixels, preserveICC: false, allowFourComponents: true});
    check(signal);
    const transpose = parsed.orientation >= 5;
    const trueW = transpose ? parsed.height : parsed.width;
    const trueH = transpose ? parsed.width : parsed.height;
    let scale = forcedScale ?? chooseJpegIdctScale(trueW, trueH, outputs);
    let plan = makeSubsamplingPlan(parsed.width, parsed.height, parsed.components, parsed.ycbcr, scale);
    if (!plan) {
      scale = 8;
      plan = makeSubsamplingPlan(parsed.width, parsed.height, parsed.components, parsed.ycbcr, 8);
    }
    if (parsed.components.length === 4 && (parsed.iccBytes || parsed.profile)) {
      throw jpegError('CMYK/YCCK with ICC: pass RGBA pixels', 'JXL_UNSUPPORTED');
    }
    if (parsed.components.length === 4 && ![0, 2].includes(parsed.adobeTransform)) {
      throw jpegError(parsed.adobeTransform < 0
        ? 'CMYK/YCCK without APP14: pass RGBA pixels'
        : 'CMYK/YCCK APP14: pass RGBA pixels', 'JXL_UNSUPPORTED');
    }
    let rgba, outW = parsed.width, outH = parsed.height;
    if (plan) {
      outW = plan.outW; outH = plan.outH;
      rgba = new Uint8Array(outW * outH * 4);
      jpegKernels().renderParsedBands(parsed, plan, (y, rows, view) => {
        rgba.set(view, y * outW * 4);
      });
    } else {
      scale = 8;
      rgba = new Uint8Array(outW * outH * 4);
      await jpegKernels().renderGeneralBands(parsed, (y, rows, view) => {
        rgba.set(view, y * outW * 4);
      });
    }
    decoded = {
      data: rgba, width: outW, height: outH,
      origWidth: parsed.width, origHeight: parsed.height,
      orientation: parsed.orientation, alreadyOriented: false,
      colorSpace: parsed.colorSpace, icc: parsed.iccBytes, renderingIntent: parsed.renderingIntent, scale,
    };
  }

  check(signal);
  const transpose = decoded.orientation >= 5;
  const trueWidth = transpose ? decoded.origHeight : decoded.origWidth;
  const trueHeight = transpose ? decoded.origWidth : decoded.origHeight;
  dimensions(trueWidth, trueHeight, maxPixels ?? 40000000);

  let picture = {
    data: decoded.data,
    width: decoded.width,
    height: decoded.height,
    ...(decoded.icc ? {icc: decoded.icc} : decoded.renderingIntent && decoded.renderingIntent !== 'relative'
      ? {colorEncoding: namedEncoding(decoded.colorSpace, decoded.renderingIntent)} : {colorSpace: decoded.colorSpace}),
  };
  if (decoded.orientation > 1 && !decoded.alreadyOriented) {
    picture = await orientSamples({...picture, orientation: decoded.orientation}, {signal, maxPixels});
  }
  if (picture.width !== trueWidth || picture.height !== trueHeight) {
    Object.defineProperty(picture, JPEG_GEOMETRY_SYMBOL, {value: {width: trueWidth, height: trueHeight}, configurable: true});
  }
  return picture;
}
