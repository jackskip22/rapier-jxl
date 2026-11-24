// JPEG coefficient reader. MIT (images/jxl/LICENSE).
import {LIMITS} from './limits.mjs';
import {prepareICCSteps} from './icc-write.mjs';
import {inspectICCSteps} from './icc-profile.mjs';
import {kernelHooks} from './kernel-hooks.mjs';
import {complete} from './bits.mjs';
import {carried, PASSED, unit, stage, journaling, journalJoin, readAll, sliceBytes, journalTool} from './step-journal.mjs';
import {ZIGZAG, jpegError} from './jpeg-tables.mjs';
import {exifOrientation} from './exif-orientation.mjs';
import {jpegYCbCr} from './jpeg-color.mjs';

export {ZIGZAG, jpegError};
export const CERTIFIED_SCANS = new WeakMap();




export function buildHuffman(counts, symbols) {
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
export function validateHuffman(counts) {
  let code = 0;
  for (let length = 1; length <= 16; length++) {
    const n = counts[length - 1];
    if (n && (code + n) * (1 << (16 - length)) >= 65536) throw jpegError('Huffman table');
    code = (code + n) * 2;
  }
}

const SRGB = [0.436, 0.2225, 0.0139, 0.3851, 0.7169, 0.0971, 0.143, 0.0606, 0.7139];
const P3 = [0.5151, 0.2412, -0.001, 0.292, 0.6922, 0.0419, 0.1571, 0.0666, 0.7841];
const CURVE = [0, 0.00516, 0.01435, 0.02934, 0.05088, 0.07958, 0.11602, 0.16068, 0.21404, 0.27652, 0.34851, 0.43039,
  0.52252, 0.62523, 0.73884, 0.86367, 1];
const PARAMETERS = [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045];
function srgbLinear(value) {
  if (value <= 0.04045) return value / 12.92;
  const base = (value + 0.055) / 1.055;
  let root = 1;
  for (let i = 0; i < 24; i++) root = (4 * root + base / (root * root * root * root)) / 5;
  return base * base * root * root;
}
export const profileSpace = profile => complete(profileSpaceSteps(profile));
const INTENTS = ['perceptual', 'relative', 'saturation', 'absolute'];
export const namedEncoding = (space, renderingIntent) => space === 'display-p3'
  ? {space: 'rgb', whitePoint: 'd65', primaries: space, transferFunction: 'srgb', renderingIntent} : {space: 'rgb', transferFunction: 'srgb', renderingIntent};
export const profileIntent = profile => INTENTS[profile.length >= 68 ? (profile[64] << 24 | profile[65] << 16 | profile[66] << 8 | profile[67]) >>> 0 : 1] ?? 'relative';
function* profileSpaceSteps(profile) {
  return yield* stage('icc-space', function* () {
    const size = profile.length;
    const u16 = at => (profile[at] << 8) | profile[at + 1];
    const u32 = at => at + 4 <= size ? ((profile[at] << 24) | (profile[at + 1] << 16) | (profile[at + 2] << 8) | profile[at + 3]) >>> 0 : 0;
    const sig = at => at + 4 <= size ? String.fromCharCode(profile[at], profile[at + 1], profile[at + 2], profile[at + 3]) : '';
    const s15 = at => (u32(at) | 0) / 65536, tags = u32(128);
    if (size < 132 || 132 + tags * 12 > size || sig(36) !== 'acsp' || sig(20) !== 'XYZ ') return null;
    const tag = function* (name) {
      for (let from = 0; from < tags; from += 4096) {
        const found = yield* unit('icc-space-tags', () => {
          for (let i = from; i < Math.min(tags, from + 4096); i++) {
            const at = 132 + i * 12, offset = u32(at + 4);
            if (sig(at) === name) return offset + u32(at + 8) <= size ? offset : -1;
          }
          return -2;
        });
        if (found !== -2) return found;
      }
      return -1;
    };
    const srgbCurve = function* (name) {
      const at = yield* tag(name);
      if (at < 0) return false;
      if (sig(at) === 'para') {
        const type = u16(at + 8), count = [1, 3, 4, 5, 7][type];
        if (type !== 3 && type !== 4) return false;
        for (let i = 0; i < count; i++) if (Math.abs(s15(at + 12 + 4 * i) - (i < 5 ? PARAMETERS[i] : 0)) > (i ? 0.002 : 0.01)) return false;
        return true;
      }
      const n = sig(at) === 'curv' ? u32(at + 8) : 0;
      if (n < 2 || at + 12 + 2 * n > size) return false;
      for (let from = 0; from < n; from += 256) if (!(yield* unit('icc-space-curve', () => {
        for (let i = from; i < Math.min(n, from + 256); i++)
          if (Math.abs(u16(at + 12 + 2 * i) / 65535 - srgbLinear(i / (n - 1))) > 0.001) return false;
        return true;
      }))) return false;
      return CURVE.every((want, k) => {
        const p = k * (n - 1) / 16, i = Math.floor(p), j = Math.min(n - 1, i + 1), f = p - i;
        return Math.abs((u16(at + 12 + 2 * i) * (1 - f) + u16(at + 12 + 2 * j) * f) / 65535 - want) <= 0.001;
      });
    };
    for (const name of ['A2B0', 'A2B1', 'A2B2']) if ((yield* tag(name)) >= 0) return null;
    if (sig(16) === 'GRAY') return (yield* srgbCurve('kTRC')) ? 'srgb' : null;
    if (sig(16) !== 'RGB ') return null;
    for (const name of ['rTRC', 'gTRC', 'bTRC']) if (!(yield* srgbCurve(name))) return null;
    const colorants = [];
    for (const name of ['rXYZ', 'gXYZ', 'bXYZ']) {
      const at = yield* tag(name);
      colorants.push(...(at >= 0 && sig(at) === 'XYZ ' ? [s15(at + 8), s15(at + 12), s15(at + 16)] : [9, 9, 9]));
    }
    const near = reference => reference.every((v, i) => Math.abs(colorants[i] - v) <= 0.004);
    return near(SRGB) ? 'srgb' : near(P3) ? 'display-p3' : null;
  });
}

export const parseJPEG = (bytes, retainScans, options, kernels) => complete(parseJPEGSteps(bytes, retainScans, options, kernels));
export function* parseJPEGSteps(bytes, retainScans = false, {preserveICC = false, compression = 'auto', bands = false, maxPixels = LIMITS.pixels, allowFourComponents = false, scalarMap = false} = {}, kernels = true) {
  bytes = sliceBytes(bytes);
  if (!(bytes.length > 4) || bytes[0] !== 0xFF || bytes[1] !== 0xD8) throw jpegError('invalid signature');
  const quant = [], huffman = [[], []], badDC = new Set(), icc = {count: 0, parts: []}, scanChoices = retainScans ? [] : null;
  const lookup = (kind, slot) => { const table = huffman[kind][slot]; return table && (table.lookup ??= buildHuffman(table.counts, table.symbols)); };
  const definition = (kind, slot) => { const table = huffman[kind][slot]; return table ? {counts: table.counts, symbols: table.symbols} : null; };
  let frame = null, restartInterval = 0, adobeTransform = -1, jfif = false, orientation = null, isoGain = false, pos = 2;
  let markerCount = 0, huffmanCount = 0;
  const padding = retainScans ? {bits: [], zero: false, kernelScans: 0} : null;
  const u16 = at => (bytes[at] << 8) | bytes[at + 1];
  const signatureAt = (at, signature) => {
    for (let i = 0; i < signature.length; i++) if (bytes[at + i] !== signature.charCodeAt(i)) return false;
    return true;
  };
  for (;;) {
    if (pos >= bytes.length) { if (frame && frame.scans) break; throw jpegError('truncated'); }
    if (bytes[pos] !== 0xFF) throw jpegError('marker');
    while (bytes[pos] === 0xFF) pos++;
    const marker = bytes[pos++];
    if (++markerCount > 16384) throw jpegError('markers: max 16384');
    if (marker === 0xD9) break;
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
        if (frame?.progressive && frame.components.some(c => c.tq === tq && c.quant && c.coverage.some(v => v !== 0) && c.quant.some((v, k) => v !== table[k]))) throw jpegError('quantization table changed');
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
    } else if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
      if (frame) throw jpegError('multiple frames');
      if (end - segment < 6) throw jpegError('frame header');
      if (bytes[segment] !== 8) throw jpegError('bit depth: 8');
      const height = u16(segment + 1), width = u16(segment + 3), count = bytes[segment + 5];
      if (!width || !height) throw jpegError('DNL height');
      if (count === 4 && !allowFourComponents) throw jpegError('CMYK/YCCK: pass pixels');
      if (count !== 1 && count !== 3 && !(allowFourComponents && count === 4)) throw jpegError('components: 1, 3 or 4');
      if (end - segment < 6 + count * 3) throw jpegError('frame header');
      if (width > LIMITS.edge || height > LIMITS.edge) throw jpegError('side: max ' + LIMITS.edge, 'JXL_DIMENSIONS');
      const most = Math.min(LIMITS.pixels, maxPixels);
      if (width * height > most) throw jpegError('pixels: max ' + most, 'JXL_DIMENSIONS');
      const components = [];
      for (let i = 0, at = segment + 6; i < count; i++, at += 3) {
        const h = bytes[at + 1] >> 4, v = bytes[at + 1] & 15, tq = bytes[at + 2];
        if (h < 1 || h > 4 || v < 1 || v > 4) throw jpegError('sampling factors');
        if (tq > 3) throw jpegError('quantization table');
        if (components.some(c => c.id === bytes[at])) throw jpegError('duplicate component id');
        components.push({id: bytes[at], h, v, tq, pred: 0, coverage: new Int8Array(64).fill(-1)});
      }
      const hmax = Math.max(...components.map(c => c.h)), vmax = Math.max(...components.map(c => c.v));
      const mcusX = Math.ceil(width / (8 * hmax)), mcusY = Math.ceil(height / (8 * vmax));
      const planes = components.reduce((n, c) => n + Math.ceil(width / (8 * hmax)) * c.h * Math.ceil(height / (8 * vmax)) * c.v * 128, 0);
      const banded = !!bands && (marker !== 0xC2 || journaling()) && planes > (bands.from ?? 0);
      for (const c of components) {
        c.blocksW = Math.ceil(Math.ceil(width * c.h / hmax) / 8); c.blocksH = Math.ceil(Math.ceil(height * c.v / vmax) / 8);
        c.stride = mcusX * c.h; c.rows = mcusY * c.v;
      }
      if ((bytes.length - end) * 8 < components.reduce((n, c) => n + c.blocksW * c.blocksH, 0)) throw jpegError('scan: incomplete');
      for (const c of components) {
        if (banded) {
          c.dc = new Int16Array(c.stride * c.rows); c.natural = new Uint32Array(64); c.coeffs = null; c.row0 = -1;
          if (marker === 0xC2) c.parts = [];
        }
        else c.coeffs = new Int16Array(c.stride * c.rows * 64);
      }
      frame = {progressive: marker === 0xC2, width, height, components, hmax, vmax, mcusX, mcusY, scans: 0, bands: banded ? [] : null,
        packedLimit: bands?.packed ?? PACKED_BYTES};
    } else if (marker === 0xC3 || (marker >= 0xC5 && marker <= 0xC7) || (marker >= 0xC9 && marker <= 0xCB) || (marker >= 0xCD && marker <= 0xCF)) {
      throw jpegError('coding: baseline or progressive');
    } else if (marker === 0xDD) { if (length < 4) throw jpegError('segment length'); restartInterval = u16(segment); }
    else if (marker === 0xDC) throw jpegError('DNL marker');
    else if (marker === 0xDA) {
      if (!frame) throw jpegError('scan before frame');
      const n = bytes[segment], scan = [];
      if (n < 1 || n > 4 || segment + 1 + n * 2 + 3 > end) throw jpegError('scan header');
      let at = segment + 1;
      for (let i = 0; i < n; i++, at += 2) {
        const component = frame.components.find(c => c.id === bytes[at]);
        if (!component) throw jpegError('unknown scan component');
        if (scan.some(s => s.component === component)) throw jpegError('duplicate scan component');
        if (!component.quant) component.quant = quant[component.tq];
        if (!component.quant) throw jpegError('missing quantization table');
        const td = bytes[at + 1] >> 4, ta = bytes[at + 1] & 15;
        if (td > 3 || ta > 3) throw jpegError('table selector: 0-3');
        scan.push({component, dc: lookup(0, td), ac: lookup(1, ta), dcSlot: td, tables: [definition(0, td), definition(1, ta)]});
      }
      if (n > 1 && scan.reduce((sum, s) => sum + s.component.h * s.component.v, 0) > 10) throw jpegError('sampling factors');
      const ss = bytes[at], se = bytes[at + 1], ah = bytes[at + 2] >> 4, al = bytes[at + 2] & 15;
      if ((!frame.progressive || (ss === 0 && ah === 0)) && scan.some(s => badDC.has(s.dcSlot))) throw jpegError('Huffman table');
      const choices = scanChoices ? {resets: [], zeros: []} : null;
      pos = yield* decodeScan(bytes, end, frame, scan, ss, se, ah, al, restartInterval, choices, padding, kernels);
      if (choices) scanChoices.push(choices);
      frame.scans++;
    } else if (marker === 0xE0) {
      if (signatureAt(segment, 'JFIF')) jfif = true;
    } else if (marker === 0xE1) {
      if (signatureAt(segment, 'Exif\0\0')) orientation ??= exifOrientation(bytes, segment + 6, end) ?? 1;
    } else if (marker === 0xE2) {
      if (length >= 16 && signatureAt(segment, 'ICC_PROFILE\0')) {
        const seq = bytes[segment + 12], count = bytes[segment + 13];
        if (!seq || !count || seq > count || (icc.count && icc.count !== count) || icc.parts[seq]) throw jpegError('ICC profile: incomplete');
        icc.count = count; icc.parts[seq] = sliceBytes(bytes, segment + 14, end);
      } else if (length >= 35 && signatureAt(segment, 'urn:iso:std:iso:ts:21496:-1\0')) isoGain = true;
    } else if (marker === 0xEE) {
      if (length >= 14 && signatureAt(segment, 'Adobe')) adobeTransform = bytes[segment + 11];
    }
  }
  if (!frame || !frame.scans) throw jpegError('missing frame');
  if (padding?.zero && padding.kernelScans) return yield* parseJPEGSteps(bytes, retainScans, {preserveICC, compression, bands, maxPixels, allowFourComponents, scalarMap}, false);
  for (const c of frame.components) {
    for (let k = 0; k < 64; k++) if (c.coverage[k] !== 0) throw jpegError(frame.progressive ? 'progressive scans: incomplete' : 'missing component scan');
  }
  if (frame.progressive && frame.bands) yield* journalTool('jpegSummary')(frame);
  if (frame.components.length === 4 && icc.count && allowFourComponents) {
    throw jpegError('CMYK/YCCK with ICC: pass RGBA pixels', 'JXL_UNSUPPORTED');
  }
  let colorSpace = 'srgb', profile, iccBytes, renderingIntent;
  if (icc.count) {
    const prepared = yield* stage('jpeg-profile', function* () {
      const parts = [];
      for (let i = 1; i <= icc.count; i++) { if (!icc.parts[i]) throw jpegError('ICC profile: incomplete'); parts.push(icc.parts[i]); }
      const original = journaling() ? journalJoin(parts) : new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      if (!journaling()) for (let i = 0, at = 0; i < parts.length; at += parts[i].length, i++) original.set(parts[i], at);
      const expected = frame.components.length === 1 ? 'gray' : frame.components.length === 4 ? 'cmyk' : 'rgb';
      const declared = original.length >= 4 ? ((original[0] << 24) | (original[1] << 16) | (original[2] << 8) | original[3]) >>> 0 : 0;
      const color = declared >= 132 && declared < original.length ? sliceBytes(original, 0, declared) : original;
      try {
        const channels = yield* inspectICCSteps(color, undefined, scalarMap || (retainScans && !preserveICC && isoGain && expected === 'gray') ? undefined : expected);
        if (scalarMap || channels !== frame.components.length) return {colorSpace: 'srgb', profile: undefined};
        const named = yield* profileSpaceSteps(color);
        const keep = preserveICC || !named;
        return {colorSpace: named || 'srgb', profile: keep ? yield* prepareICCSteps(color, {compression, colorSpace: expected}) : undefined,
          iccBytes: named ? undefined : color, renderingIntent: keep ? undefined : profileIntent(color)};
      } catch (error) {
        if (error.code === 'JXL_INPUT') throw jpegError('ICC profile: ' + error.message);
        throw error;
      }
    });
    ({colorSpace, profile, iccBytes, renderingIntent} = prepared);
  }
  const ycbcr = jpegYCbCr(frame.components, jfif, adobeTransform);
  const banded = frame.bands ? groupRows(bytes, frame) : {};
  return {...banded, end: pos, width: frame.width, height: frame.height, components: frame.components, progressive: frame.progressive, ycbcr, adobeTransform, orientation: orientation ?? 1, ...(orientation !== null && {hasOrientation: true}), colorSpace,
    ...(renderingIntent && renderingIntent !== 'relative' && {renderingIntent}), ...(profile ? {profile, level: profile.level} : {}), ...(iccBytes ? {iccBytes} : {}), ...(scanChoices ? {scanChoices} : {}), ...(padding?.zero ? {padding: Uint8Array.from(padding.bits)} : {})};
}

export function admitScan(frame, scan, ss, se, ah, al) {
  const progressive = frame.progressive;
  if (!progressive) {
    if (ss !== 0 || se !== 63 || ah !== 0 || al !== 0) throw jpegError('spectral selection');
    for (const s of scan) { if (s.component.coverage.some(v => v !== -1)) throw jpegError('duplicate component scan'); s.component.coverage.fill(0); }
    return;
  }
  if (al > 13 || (ah && ah !== al + 1)) throw jpegError('successive approximation');
  if (ss === 0) {
    if (se !== 0) throw jpegError('spectral selection');
    for (const {component} of scan) {
      if (component.coverage[0] !== (ah ? ah : -1)) throw jpegError(ah ? 'refinement scan order' : 'duplicate DC scan');
      component.coverage[0] = al;
    }
    return;
  }
  if (scan.length !== 1) throw jpegError('interleaved AC scan');
  if (se > 63 || ss > se) throw jpegError('spectral selection');
  const {coverage} = scan[0].component;
  if (coverage[0] === -1) throw jpegError('AC before DC scan');
  for (let k = ss; k <= se; k++) {
    if (coverage[k] !== (ah ? ah : -1)) throw jpegError(ah ? 'refinement scan order' : 'duplicate band scan');
    coverage[k] = al;
  }
}

const WINDOW = 65536, AHEAD = 8192;
class ScanReader {
  constructor(bytes, start, frame, scan, ss, se, ah, al, choices, padding) {
    this.padding = padding; this.bytes = bytes; this.pos = start; this.clean = new Uint8Array(0); this.bit = 0; this.limit = 0;
    this.pieced = !ArrayBuffer.isView(bytes); this.spanAt = 0; this.spanBytes = this.pieced ? new Uint8Array(0) : bytes;
    this.base = start; this.n = 0; this.ended = false;
    this.scan = scan; this.ss = ss; this.se = se; this.ah = ah; this.al = al; this.choices = choices;
    this.progressive = frame.progressive; this.eobrun = -1; this.blockIndex = 0;
    this.mode = !this.progressive ? 0 : ss === 0 ? (ah === 0 ? 1 : 2) : (ah === 0 ? 3 : 4);
  }
  load() { this.base = this.pos; this.n = 0; this.bit = 0; this.ended = false; this.refill(); }
  rawAfter(raw, count) {
    let [bytes, at] = this.span(raw, raw + 2 * count + 2), i = raw - at;
    while (count > 0) {
      if (i + 1 >= bytes.length && i + at + 1 < this.bytes.length) { const from = i + at; [bytes, at] = this.span(from, from + 2 * count + 2); i = from - at; }
      if (bytes[i] !== 0xFF) { i++; count--; }
      else if (bytes[i + 1] === 0) { i += 2; count--; }
      else i++;
    }
    return i + at;
  }
  span(from, to) {
    if (!this.pieced) return [this.bytes, 0];
    to = Math.min(this.bytes.length, to);
    if (from < this.spanAt || to > this.spanAt + this.spanBytes.length) {
      this.spanAt = from; this.spanBytes = this.bytes.subarray(from, Math.min(this.bytes.length, Math.max(to, from + 4 * WINDOW)));
    }
    return [this.spanBytes, this.spanAt];
  }
  refill() {
    const bytes = this.bytes, keep = this.bit >>> 3;
    if (keep) { this.base = this.rawAfter(this.base, keep); this.clean.copyWithin(0, keep, this.n); this.n -= keep; this.bit &= 7; }
    if (this.clean.length < this.n + WINDOW + 4) { const grown = new Uint8Array(this.n + WINDOW + 4); grown.set(this.clean.subarray(0, this.n)); this.clean = grown; }
    const clean = this.clean, stop = this.n + WINDOW, length = bytes.length;
    let n = this.n, pos = this.pos, ended = true;
    let [raw, at] = this.span(pos, pos + 2 * (stop - n) + 2);
    while (pos < length) {
      if (n === stop) { ended = false; break; }
      if (pos + 1 - at >= raw.length && pos + 1 < length) [raw, at] = this.span(pos, pos + 2 * (stop - n) + 2);
      const byte = raw[pos - at];
      if (byte === 0xFF) {
        const next = pos + 1 < length ? raw[pos + 1 - at] : undefined;
        if (next === 0) { clean[n++] = 0xFF; pos += 2; continue; }
        if (next === 0xFF) { pos++; continue; }
        break;
      }
      clean[n++] = byte; pos++;
    }
    clean.fill(0, n, n + 4); this.pos = pos; this.n = n; this.limit = n * 8; this.ended = ended;
  }
  ensure() { if (!this.ended && this.limit - this.bit < AHEAD * 8) this.refill(); }
  here() { return {pos: this.rawAfter(this.base, this.bit >>> 3), bit: this.bit & 7}; }
  window() { const clean = this.clean, bit = this.bit, at = bit >>> 3; return ((clean[at] << 24 | clean[at + 1] << 16 | clean[at + 2] << 8 | clean[at + 3]) << (bit & 7)) >>> 0; }
  receive(n) {
    if (!n) return 0;
    if (this.bit + n > this.limit) throw jpegError('scan: incomplete');
    const value = this.window() >>> (32 - n); this.bit += n; return value;
  }
  decode(table) {
    if (!table) throw jpegError('missing Huffman table');
    const entry = table[this.window() >>> 16];
    if (!entry) throw jpegError('Huffman code');
    if (this.bit + (entry >> 8) > this.limit) throw jpegError('scan: incomplete');
    this.bit += entry >> 8;
    return entry & 255;
  }
  atMarker(final = false) {
    while (!this.ended) this.refill();
    const remaining = this.limit - this.bit, padding = remaining & 7, fill = remaining >>> 3, bytes = this.bytes;
    if (fill) {
      if (!final || this.clean.subarray((this.bit + 7) >>> 3, this.limit >>> 3).some(byte => byte !== 255)) throw jpegError('trailing scan bytes');
      if (this.choices) this.choices.fill = fill;
    }
    if (this.eobrun > 0) throw jpegError('EOB run past interval');
    if (padding) {
      const bits = this.window() >>> (32 - padding), list = this.padding;
      if (list && bits !== (1 << padding) - 1) list.zero = true;
      if (list) for (let i = padding - 1; i >= 0; i--) list.bits.push((bits >>> i) & 1);
    }
    while (this.pos + 1 < bytes.length && bytes[this.pos] === 0xFF && bytes[this.pos + 1] === 0xFF) this.pos++;
  }
  restart(index) {
    this.atMarker();
    if (!(this.bytes[this.pos] === 0xFF && this.bytes[this.pos + 1] === 0xD0 + (index & 7))) throw jpegError('restart marker');
    this.pos += 2; this.load();
    for (const s of this.scan) s.component.pred = 0;
    this.eobrun = -1;
  }
  dcValue(s, t) {
    if (t > 11) throw jpegError('DC range');
    const diff = t ? extend(this.receive(t), t) : 0;
    s.component.pred += diff;
    if (s.component.pred > 2047 || s.component.pred < -2048) throw jpegError('DC range');
    return s.component.pred;
  }
  acValue(size, shift) {
    if (size > 10) throw jpegError('AC range');
    const value = extend(this.receive(size), size) * (1 << shift);
    if (value > 1023 || value < -1023) throw jpegError('AC range');
    return value;
  }
  block(s, coeffs, at) {
    switch (this.mode) {
      case 0: coeffs[at] = this.dcValue(s, this.decode(s.dc)); this.acFirst(s, coeffs, at); break;
      case 1: {
        const value = this.dcValue(s, this.decode(s.dc)) * (1 << this.al);
        if (value > 2047 || value < -2048) throw jpegError('DC range');
        coeffs[at] = value; break;
      }
      case 2: if (this.receive(1)) coeffs[at] |= 1 << this.al; break;
      case 3: this.acFirst(s, coeffs, at); break;
      default: this.acRefine(s, coeffs, at);
    }
    this.blockIndex++;
  }
  pastBand() { return jpegError('past ' + (this.progressive ? 'band' : 'block')); }
  acFirst(s, coeffs, at) {
    if (this.eobrun > 0) { this.eobrun--; return; }
    const ended = this.eobrun === 0, {ss, se, al, progressive, choices} = this;
    this.eobrun = -1;
    let zeroRuns = 0;
    for (let k = ss || 1; k <= se;) {
      const rs = this.decode(s.ac), r = rs >> 4, size = rs & 15;
      if (!size) {
        if (r < 15) {
          if (r && !progressive) throw jpegError('sequential EOB run');
          if (progressive && k === ss && ended) choices?.resets.push(this.blockIndex);
          this.eobrun = (1 << r) - 1 + (r ? this.receive(r) : 0); break;
        }
        k += 16; zeroRuns++; if (k > se + 1) throw this.pastBand(); continue;
      }
      k += r;
      if (k > se) throw this.pastBand();
      coeffs[at + ZIGZAG[k]] = this.acValue(size, al);
      zeroRuns = 0;
      k++;
    }
    if (zeroRuns) choices?.zeros.push({block: this.blockIndex, count: zeroRuns});
  }
  acRefine(s, coeffs, at) {
    const {ss, se, al, choices} = this, p1 = 1 << al, m1 = -1 << al;
    let k = ss;
    if (this.eobrun <= 0) {
      const ended = this.eobrun === 0;
      this.eobrun = -1;
      for (; k <= se; k++) {
        const rs = this.decode(s.ac);
        let r = rs >> 4, value = 0;
        const size = rs & 15;
        if (size) { if (size !== 1) throw jpegError('refinement code'); value = this.receive(1) ? p1 : m1; }
        else if (r !== 15) { if (k === ss && ended) choices?.resets.push(this.blockIndex); this.eobrun = 1 << r; if (r) this.eobrun += this.receive(r); break; }
        for (; k <= se; k++) {
          const z = at + ZIGZAG[k];
          if (coeffs[z] !== 0) { if (this.receive(1) && (coeffs[z] & p1) === 0) coeffs[z] += coeffs[z] >= 0 ? p1 : m1; }
          else if (--r < 0) break;
        }
        if (r >= 0 || (value && k > se)) throw jpegError('past band');
        if (value) coeffs[at + ZIGZAG[k]] = value;
      }
    }
    if (this.eobrun > 0) {
      for (; k <= se; k++) {
        const z = at + ZIGZAG[k];
        if (coeffs[z] !== 0 && this.receive(1) && (coeffs[z] & p1) === 0) coeffs[z] += coeffs[z] >= 0 ? p1 : m1;
      }
      this.eobrun--;
    }
  }
}
const extend = (value, n) => value < (1 << (n - 1)) ? value - (1 << n) + 1 : value;

const bandUnits = (frame, scan) => scan.length === 1 ? scan[0].component.blocksW * (32 * scan[0].component.v / frame.vmax) : frame.mcusX * (32 / frame.vmax);
function forUnits(frame, scan, from, to, unit, visit) {
  const single = scan.length === 1, first = scan[0].component;
  for (let u = from; u < to; u++) {
    unit?.(u);
    if (single) { const by = (u / first.blocksW) | 0; visit(scan[0], by * first.stride + u - by * first.blocksW); continue; }
    const my = (u / frame.mcusX) | 0, mx = u - my * frame.mcusX;
    for (const s of scan) {
      const c = s.component;
      for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) visit(s, (my * c.v + v) * c.stride + mx * c.h + h);
    }
  }
}
function readUnits(reader, frame, scan, from, to, restartInterval, visit) {
  forUnits(frame, scan, from, to, unit => {
    if (restartInterval && unit > 0 && unit % restartInterval === 0) reader.restart(unit / restartInterval - 1);
    reader.ensure();
  }, visit || ((s, block) => reader.block(s, s.component.coeffs, (block - (s.component.row0 | 0) * s.component.stride) * 64)));
}
const PACKED_BYTES = 32 << 20;
class Growing {
  constructor(Type) { this.Type = Type; this.values = new Type(0); this.n = 0; }
  push(value) { if (this.n === this.values.length) { const grown = new this.Type(Math.max(1024, this.n * 2)); grown.set(this.values); this.values = grown; } this.values[this.n++] = value; }
  take() { const values = this.values.slice(0, this.n); this.n = 0; return values; }
}
export function groupRows(bytes, frame) {
  const components = frame.components, count = Math.ceil(frame.mcusY / (32 / frame.vmax));
  for (const {scan} of frame.bands) for (const s of scan) {
    if (s.dc === undefined) s.dc = s.tables[0] && buildHuffman(s.tables[0].counts, s.tables[0].symbols);
    if (s.ac === undefined) s.ac = s.tables[1] && buildHuffman(s.tables[1].counts, s.tables[1].symbols);
  }
  const allPackedComp = !frame.progressive && frame.bands.length > 0 && frame.bands.every(b => b.packedComp);
  for (const c of components) { c.band = new Int16Array(32 * c.v / frame.vmax * c.stride * 64); if (allPackedComp) c._dirty = []; }
  const sink = {bits: [], zero: false};
  let current = -1;
  const band = gy => {
    if (gy === current) return;
    if (frame.progressive) readAll(components.flatMap(c => c.parts.slice(gy * 32 / frame.vmax, Math.min(frame.mcusY, (gy + 1) * 32 / frame.vmax))));
    current = gy;
    for (const c of components) {
      c.coeffs = c.band; c.row0 = gy * (32 * c.v / frame.vmax);
      if (allPackedComp) {
        const coeffs = c.band, stride = c.stride;
        for (const {width, rows, counts, at} of c._dirty) {
          for (let r = 0, b = 0, p = 0; r < rows; r++) {
            let base = r * stride * 64;
            for (let x = 0; x < width; x++, base += 64) {
              for (let n = counts[b++]; n > 0; n--, p++) coeffs[base + at[p]] = 0;
            }
          }
        }
        c._dirty.length = 0;
      } else c.band.fill(0);
    }
    if (frame.progressive) {
      for (const c of components) for (let row = gy * 32 / frame.vmax; row < Math.min(frame.mcusY, (gy + 1) * 32 / frame.vmax); row++)
        c.band.set(c.parts[row], (row * c.v - c.row0) * c.stride * 64);
      return;
    }
    for (const {scan, restartInterval, points, total, packed, packedComp} of frame.bands) {
      const point = points[gy], end = Math.min(total, point?.unit + bandUnits(frame, scan));
      if (!point) continue;
      if (packedComp) {
        const compRows = packedComp[gy];
        for (let i = 0; i < scan.length; i++) {
          const c = scan[i].component, row = compRows[i], {width, rows, counts, at, levels} = row, coeffs = c.coeffs, stride = c.stride;
          for (let r = 0, b = 0, p = 0; r < rows; r++) {
            let base = r * stride * 64;
            for (let x = 0; x < width; x++, base += 64) {
              for (let n = counts[b++]; n > 0; n--, p++) coeffs[base + at[p]] = levels[p];
            }
          }
          if (allPackedComp) c._dirty.push(row);
        }
        continue;
      }
      if (packed) {
        const {counts, at, levels} = packed[gy];
        let j = 0, p = 0;
        forUnits(frame, scan, point.unit, end, null, ({component: c}, block) => {
          const coeffs = c.coeffs, base = (block - c.row0 * c.stride) * 64;
          for (let n = counts[j++]; n > 0; n--, p++) coeffs[base + at[p]] = levels[p];
        });
        continue;
      }
      const next = points[gy + 1], view = bytes.subarray(point.pos, next ? Math.min(bytes.length, next.pos + WINDOW + 8) : bytes.length);
      const reader = new ScanReader(view, 0, frame, scan, 0, 63, 0, 0, null, sink);
      reader.load(); reader.bit = point.bit; sink.bits.length = 0;
      scan.forEach((s, i) => { s.component.pred = point.preds[i]; });
      readUnits(reader, frame, scan, point.unit, end, restartInterval, null);
    }
  };
  return {band, *rows() { for (let gy = 0; gy < count; gy++) { band(gy); yield {components: components.map(c => ({coeffs: c.coeffs, row0: c.row0}))}; } }, bandFrame: frame};
}

function* decodeScan(bytes, start, frame, scan, ss, se, ah, al, restartInterval, choices, padding, kernels) {
  admitScan(frame, scan, ss, se, ah, al);
  if (frame.progressive && frame.bands) return yield* journalTool('jpegProgressive')(bytes, start, frame, scan, ss, se, ah, al, restartInterval, choices, padding, {ScanReader, readUnits, finishScan});
  const single = scan.length === 1, first = scan[0].component;
  const total = single ? first.blocksW * first.blocksH : frame.mcusX * frame.mcusY;
  const decoded = frame.progressive || !kernels || (frame.bands && journaling()) ? null : kernelHooks.entropy?.()?.sequentialDecode(bytes, start, frame, scan, restartInterval, ZIGZAG);
  if (decoded) {
    if (padding) padding.kernelScans++;
    if (choices) for (const [block, count] of decoded.zeros) choices.zeros.push({block, count});
    const nextPos = finishScan(bytes, decoded.pos, total, restartInterval, choices);
    if (choices && decoded.canonical && choices.finalRestart === undefined && ArrayBuffer.isView(bytes) && !journaling())
      CERTIFIED_SCANS.set(choices, {buffer: bytes.buffer, byteOffset: bytes.byteOffset, start, end: nextPos, restart: restartInterval, tables: scan.map(s => s.tables)});
    return nextPos;
  }
  const reader = new ScanReader(bytes, start, frame, scan, ss, se, ah, al, choices, padding);
  for (const s of scan) s.component.pred = 0;
  reader.load();
  const bands = frame.bands, per = bands ? bandUnits(frame, scan) : total, points = [], scratch = new Int16Array(64);
  const entry = {scan, restartInterval, points, total, packed: frame.packed === false ? null : []};
  const counts = new Growing(Uint8Array), at = new Growing(Uint8Array), levels = new Growing(Int16Array);
  const visit = bands && ((s, block) => {
    reader.block(s, scratch, 0);
    const c = s.component, natural = c.natural, packed = entry.packed;
    c.dc[block] = scratch[0];
    let n = 0;
    for (let i = 0; i < 64; i++) if (scratch[i]) {
      natural[i]++;
      if (packed) { at.push(i); levels.push(scratch[i]); n++; }
      scratch[i] = 0;
    }
    if (packed) counts.push(n);
  });
  if (bands) bands.push(entry);
  const row = unit => {
    if (bands) points.push({unit, ...reader.here(), preds: scan.map(s => s.component.pred)});
    readUnits(reader, frame, scan, unit, Math.min(total, unit + per), restartInterval, visit);
    if (!entry.packed || !bands) return null;
    const row = {counts: counts.take(), at: at.take(), levels: levels.take()};
    frame.packedBytes = (frame.packedBytes || 0) + row.counts.length + row.at.length * 3;
    if (frame.packedBytes <= frame.packedLimit) { entry.packed.push(row); return null; }
    frame.packed = false;
    for (const other of bands) other.packed = null;
    return null;
  };
  const state = () => ({...reader.here(), preds: scan.map(s => s.component.pred), block: reader.blockIndex, points,
    dc: scan.map(s => s.component.dc), natural: scan.map(s => s.component.natural), packed: entry.packed, packedBytes: frame.packedBytes ?? 0,
    resets: choices?.resets ?? null, zeros: choices?.zeros ?? null, padding: padding && {bits: padding.bits, zero: padding.zero}});
  for (let unit = 0; unit < total; unit += per) {
    if (!bands) { row(unit); continue; }
    const saved = yield* carried('scan-' + frame.scans, () => row(unit), state);
    if (saved === null || saved === PASSED) continue;
    reader.pos = saved.pos; reader.load(); reader.bit = saved.bit; reader.blockIndex = saved.block;
    scan.forEach((s, i) => { s.component.pred = saved.preds[i]; s.component.dc.set(saved.dc[i]); s.component.natural.set(saved.natural[i]); });
    points.length = 0; points.push(...saved.points); entry.packed = saved.packed; frame.packedBytes = saved.packedBytes;
    if (choices) { choices.resets = saved.resets; choices.zeros = saved.zeros; }
    if (padding) { padding.bits = saved.padding.bits; padding.zero = saved.padding.zero; }
  }
  reader.atMarker(true);
  return finishScan(bytes, reader.pos, total, restartInterval, choices);
}

function finishScan(bytes, pos, total, restartInterval, choices) {
  if (bytes[pos] === 0xFF && bytes[pos + 1] >= 0xD0 && bytes[pos + 1] <= 0xD7) {
    if (!restartInterval || total % restartInterval || bytes[pos + 1] !== 0xD0 + ((total / restartInterval - 1) & 7)) throw jpegError('restart marker');
    if (choices) choices.finalRestart = bytes[pos + 1];
    pos += 2;
    while (pos + 1 < bytes.length && bytes[pos] === 0xFF && bytes[pos + 1] === 0xFF) pos++;
  }
  if (pos < bytes.length && !(bytes[pos] === 0xFF && pos + 1 < bytes.length && bytes[pos + 1] !== 0 && bytes[pos + 1] !== 0xFF)) throw jpegError('trailing scan bytes');
  return pos;
}
