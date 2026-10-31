// JPEG coefficient reader. MIT (images/jxl/LICENSE).
import {JPEG_LIMITS} from './limits.mjs';
import {prepareICC} from './icc-write.mjs';
import {inspectICC} from './icc-profile.mjs';
import {kernelHooks} from './kernel-hooks.mjs';
import {ZIGZAG, jpegError} from './jpeg-tables.mjs';

export {ZIGZAG, jpegError};




function buildHuffman(counts, symbols) {
  const lookup = new Uint16Array(65536);
  let code = 0, k = 0;
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < counts[length - 1]; i++) {
      const symbol = symbols[k++], start = code << (16 - length), n = 1 << (16 - length);
      if (start + n >= 65536) throw jpegError('bad Huffman table');
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
    if (n && (code + n) * (1 << (16 - length)) >= 65536) throw jpegError('bad Huffman table');
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
export function profileSpace(profile) {
  const size = profile.length;
  const u16 = at => (profile[at] << 8) | profile[at + 1];
  const u32 = at => at + 4 <= size ? ((profile[at] << 24) | (profile[at + 1] << 16) | (profile[at + 2] << 8) | profile[at + 3]) >>> 0 : 0;
  const sig = at => at + 4 <= size ? String.fromCharCode(profile[at], profile[at + 1], profile[at + 2], profile[at + 3]) : '';
  const s15 = at => (u32(at) | 0) / 65536, tags = u32(128);
  if (size < 132 || 132 + tags * 12 > size || sig(36) !== 'acsp' || sig(20) !== 'XYZ ') return null;
  const tag = name => {
    for (let i = 0; i < tags; i++) { const at = 132 + i * 12, offset = u32(at + 4); if (sig(at) === name) return offset + u32(at + 8) <= size ? offset : -1; }
    return -1;
  };
  const srgbCurve = name => {
    const at = tag(name);
    if (at < 0) return false;
    if (sig(at) === 'para') {
      const type = u16(at + 8), count = [1, 3, 4, 5, 7][type];
      if (type !== 3 && type !== 4) return false;
      for (let i = 0; i < count; i++) if (Math.abs(s15(at + 12 + 4 * i) - (i < 5 ? PARAMETERS[i] : 0)) > (i ? 0.002 : 0.01)) return false;
      return true;
    }
    const n = sig(at) === 'curv' ? u32(at + 8) : 0;
    if (n < 2 || at + 12 + 2 * n > size) return false;
    for (let i = 0; i < n; i++) if (Math.abs(u16(at + 12 + 2 * i) / 65535 - srgbLinear(i / (n - 1))) > 0.001) return false;
    return CURVE.every((want, k) => {
      const p = k * (n - 1) / 16, i = Math.floor(p), j = Math.min(n - 1, i + 1), f = p - i;
      return Math.abs((u16(at + 12 + 2 * i) * (1 - f) + u16(at + 12 + 2 * j) * f) / 65535 - want) <= 0.001;
    });
  };
  if (['A2B0', 'A2B1', 'A2B2'].some(name => tag(name) >= 0)) return null;
  if (sig(16) === 'GRAY') return srgbCurve('kTRC') ? 'srgb' : null;
  if (sig(16) !== 'RGB ' || !['rTRC', 'gTRC', 'bTRC'].every(srgbCurve)) return null;
  const colorants = ['rXYZ', 'gXYZ', 'bXYZ'].flatMap(name => { const at = tag(name); return at >= 0 && sig(at) === 'XYZ ' ? [s15(at + 8), s15(at + 12), s15(at + 16)] : [9, 9, 9]; });
  const near = reference => reference.every((v, i) => Math.abs(colorants[i] - v) <= 0.004);
  return near(SRGB) ? 'srgb' : near(P3) ? 'display-p3' : null;
}

export function parseJPEG(bytes, retainScans = false, {preserveICC = false, compression = 'auto'} = {}) {
  if (!(bytes.length > 4) || bytes[0] !== 0xFF || bytes[1] !== 0xD8) throw jpegError('not a JPEG');
  const quant = [], huffman = [[], []], badDC = new Set(), icc = {count: 0, parts: []}, scanChoices = retainScans ? [] : null;
  const lookup = (kind, slot) => { const table = huffman[kind][slot]; return table && (table.lookup ??= buildHuffman(table.counts, table.symbols)); };
  let frame = null, restartInterval = 0, adobeTransform = -1, jfif = false, orientation = null, pos = 2;
  let markerCount = 0, huffmanCount = 0;
  const u16 = at => (bytes[at] << 8) | bytes[at + 1];
  const signatureAt = (at, signature) => {
    for (let i = 0; i < signature.length; i++) if (bytes[at + i] !== signature.charCodeAt(i)) return false;
    return true;
  };
  for (;;) {
    if (pos >= bytes.length) { if (frame && frame.scans) break; throw jpegError('truncated'); }
    if (bytes[pos] !== 0xFF) throw jpegError('marker expected');
    while (bytes[pos] === 0xFF) pos++;
    const marker = bytes[pos++];
    if (++markerCount > 16384) throw jpegError('more than 16384 JPEG markers');
    if (marker === 0xD9) break;
    if (marker === 0xD8) throw jpegError('a second start');
    if (marker >= 0xD0 && marker <= 0xD7) throw jpegError('a restart marker outside a scan');
    if (marker === 0x01) continue;
    if (pos + 2 > bytes.length) throw jpegError('truncated');
    const length = u16(pos), segment = pos + 2, end = pos + length;
    if (length < 2 || end > bytes.length) throw jpegError('bad segment');
    pos = end;
    if (marker === 0xDB) {
      for (let at = segment; at < end;) {
        const pq = bytes[at] >> 4, tq = bytes[at] & 15;
        if (pq > 1 || tq > 3 || at + 1 + (pq ? 128 : 64) > end) throw jpegError('bad quantisation table');
        at++;
        const table = new Int32Array(64);
        for (let k = 0; k < 64; k++) { table[ZIGZAG[k]] = pq ? u16(at) : bytes[at]; at += pq ? 2 : 1; if (!table[ZIGZAG[k]]) throw jpegError('a zero quantisation step'); }
        if (frame?.progressive && frame.components.some(c => c.tq === tq && c.quant && c.coverage.some(v => v !== 0) && c.quant.some((v, k) => v !== table[k]))) throw jpegError('a quantisation table changed between progressive scans');
        quant[tq] = table;
      }
    } else if (marker === 0xC4) {
      for (let at = segment; at < end;) {
        if (++huffmanCount > 89) throw jpegError('more than 89 JPEG Huffman tables');
        const tc = bytes[at] >> 4, th = bytes[at] & 15;
        if (tc > 1 || th > 3 || at + 17 > end) throw jpegError('bad Huffman table');
        at++;
        const counts = bytes.subarray(at, at + 16);
        let total = 0;
        for (const c of counts) total += c;
        if (total > 256 || at + 16 + total > end) throw jpegError('bad Huffman table');
        const symbols = bytes.subarray(at + 16, at + 16 + total);
        validateHuffman(counts);
        huffman[tc][th] = {counts, symbols, lookup: null};
        if (tc === 0) { if (symbols.some(s => s > 15)) badDC.add(th); else badDC.delete(th); }
        at += 16 + total;
      }
    } else if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
      if (frame) throw jpegError('two frames');
      if (end - segment < 6) throw jpegError('bad frame header');
      if (bytes[segment] !== 8) throw jpegError('only 8-bit samples');
      const height = u16(segment + 1), width = u16(segment + 3), count = bytes[segment + 5];
      if (!width || !height) throw jpegError('a height left to a DNL marker');
      if (count !== 1 && count !== 3) throw jpegError('only gray or three components');
      if (end - segment < 6 + count * 3) throw jpegError('bad frame header');
      if (width > JPEG_LIMITS.edge || height > JPEG_LIMITS.edge) throw jpegError('a picture past ' + JPEG_LIMITS.edge + ' pixels on a side', 'JXL_DIMENSIONS');
      if (width * height > JPEG_LIMITS.pixels) throw jpegError('a picture past ' + JPEG_LIMITS.pixels + ' pixels', 'JXL_DIMENSIONS');
      const components = [];
      for (let i = 0, at = segment + 6; i < count; i++, at += 3) {
        const h = bytes[at + 1] >> 4, v = bytes[at + 1] & 15, tq = bytes[at + 2];
        if (h < 1 || h > 4 || v < 1 || v > 4) throw jpegError('bad sampling');
        if (tq > 3) throw jpegError('bad quantisation table');
        if (components.some(c => c.id === bytes[at])) throw jpegError('two components with one id');
        components.push({id: bytes[at], h, v, tq, pred: 0, coverage: new Int8Array(64).fill(-1)});
      }
      const hmax = Math.max(...components.map(c => c.h)), vmax = Math.max(...components.map(c => c.v));
      const mcusX = Math.ceil(width / (8 * hmax)), mcusY = Math.ceil(height / (8 * vmax));
      for (const c of components) {
        c.blocksW = Math.ceil(Math.ceil(width * c.h / hmax) / 8); c.blocksH = Math.ceil(Math.ceil(height * c.v / vmax) / 8);
        c.stride = mcusX * c.h; c.rows = mcusY * c.v;
        c.coeffs = new Int16Array(c.stride * c.rows * 64);
      }
      frame = {progressive: marker === 0xC2, width, height, components, hmax, vmax, mcusX, mcusY, scans: 0};
    } else if (marker === 0xC3 || (marker >= 0xC5 && marker <= 0xC7) || (marker >= 0xC9 && marker <= 0xCB) || (marker >= 0xCD && marker <= 0xCF)) {
      throw jpegError('lossless, hierarchical or arithmetic coding');
    } else if (marker === 0xDD) { if (length < 4) throw jpegError('bad segment'); restartInterval = u16(segment); }
    else if (marker === 0xDC) throw jpegError('a DNL marker');
    else if (marker === 0xDA) {
      if (!frame) throw jpegError('a scan before the frame');
      const n = bytes[segment], scan = [];
      if (n < 1 || n > 4 || segment + 1 + n * 2 + 3 > end) throw jpegError('bad scan header');
      let at = segment + 1;
      for (let i = 0; i < n; i++, at += 2) {
        const component = frame.components.find(c => c.id === bytes[at]);
        if (!component) throw jpegError('a scan of an unknown component');
        if (scan.some(s => s.component === component)) throw jpegError('a component twice in one scan');
        if (!component.quant) component.quant = quant[component.tq];
        if (!component.quant) throw jpegError('a scan without its quantisation table');
        const td = bytes[at + 1] >> 4, ta = bytes[at + 1] & 15;
        if (td > 3 || ta > 3) throw jpegError('a scan table selector above 3');
        scan.push({component, dc: lookup(0, td), ac: lookup(1, ta), dcSlot: td});
      }
      if (n > 1 && scan.reduce((sum, s) => sum + s.component.h * s.component.v, 0) > 10) throw jpegError('bad sampling');
      const ss = bytes[at], se = bytes[at + 1], ah = bytes[at + 2] >> 4, al = bytes[at + 2] & 15;
      if ((!frame.progressive || (ss === 0 && ah === 0)) && scan.some(s => badDC.has(s.dcSlot))) throw jpegError('bad Huffman table');
      const choices = scanChoices ? {resets: [], zeros: []} : null;
      pos = decodeScan(bytes, end, frame, scan, ss, se, ah, al, restartInterval, choices);
      if (choices) scanChoices.push(choices);
      frame.scans++;
    } else if (marker === 0xE0) {
      if (signatureAt(segment, 'JFIF')) jfif = true;
    } else if (marker === 0xE1) {
      if (signatureAt(segment, 'Exif') && bytes[segment + 4] === 0) orientation ??= exifOrientation(bytes, segment + 6, end);
    } else if (marker === 0xE2) {
      if (length >= 16 && signatureAt(segment, 'ICC_PROFILE\0')) {
        const seq = bytes[segment + 12], count = bytes[segment + 13];
        if (!seq || !count || seq > count || (icc.count && icc.count !== count) || icc.parts[seq]) throw jpegError('a color profile cut short');
        icc.count = count; icc.parts[seq] = bytes.subarray(segment + 14, end);
      }
    } else if (marker === 0xEE) {
      if (length >= 14 && signatureAt(segment, 'Adobe')) adobeTransform = bytes[segment + 11];
    }
  }
  if (!frame || !frame.scans) throw jpegError('no picture');
  for (const c of frame.components) {
    for (let k = 0; k < 64; k++) if (c.coverage[k] !== 0) throw jpegError(frame.progressive ? 'a progressive JPEG whose scans do not finish every coefficient' : 'a component without its scan');
  }
  let colorSpace = 'srgb', profile;
  if (icc.count) {
    const parts = [];
    for (let i = 1; i <= icc.count; i++) { if (!icc.parts[i]) throw jpegError('a color profile cut short'); parts.push(icc.parts[i]); }
    const original = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    for (let i = 0, at = 0; i < parts.length; at += parts[i].length, i++) original.set(parts[i], at);
    const expected = frame.components.length === 1 ? 'gray' : 'rgb';
    try {
      inspectICC(original, undefined, expected);
      const named = profileSpace(original);
      colorSpace = named || 'srgb';
      if (preserveICC || !named) profile = prepareICC(original, {compression, colorSpace: expected});
    } catch (error) {
      if (error.code === 'JXL_INPUT') throw jpegError('invalid or incompatible color profile: ' + error.message);
      throw error;
    }
  }
  let rgb = false;
  if (frame.components.length === 3 && !jfif) {
    if (adobeTransform >= 0) rgb = adobeTransform === 0;
    else rgb = frame.components[0].id === 0x52 && frame.components[1].id === 0x47 && frame.components[2].id === 0x42;
  }
  return {width: frame.width, height: frame.height, components: frame.components, progressive: frame.progressive, ycbcr: !rgb, orientation: orientation ?? 1, colorSpace,
    ...(profile ? {profile, level: profile.level} : {}), ...(scanChoices ? {scanChoices} : {})};
}

function exifOrientation(bytes, start, end) {
  const big = bytes[start] === 0x4D && bytes[start + 1] === 0x4D;
  if (!big && !(bytes[start] === 0x49 && bytes[start + 1] === 0x49)) return null;
  const u16 = at => at + 2 > end ? 0 : big ? (bytes[at] << 8) | bytes[at + 1] : bytes[at] | (bytes[at + 1] << 8);
  const u32 = at => at + 4 > end ? 0 : big ? ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0 : (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
  if (u16(start + 2) !== 42 || u32(start + 4) < 8) return null;
  const ifd = start + u32(start + 4), entries = u16(ifd);
  for (let i = 0, at = ifd + 2; i < entries && at + 12 <= end; i++, at += 12) {
    const value = u16(at + 8);
    if (u16(at) === 0x0112 && u16(at + 2) === 3 && u32(at + 4) === 1 && value >= 1 && value <= 8) return value;
  }
  return null;
}

export function admitScan(frame, scan, ss, se, ah, al) {
  const progressive = frame.progressive;
  if (!progressive) {
    if (ss !== 0 || se !== 63 || ah !== 0 || al !== 0) throw jpegError('a bad spectral selection');
    for (const s of scan) { if (s.component.coverage.some(v => v !== -1)) throw jpegError('a component coded twice'); s.component.coverage.fill(0); }
    return;
  }
  if (al > 13 || (ah && ah !== al + 1)) throw jpegError('a bad successive approximation');
  if (ss === 0) {
    if (se !== 0) throw jpegError('a bad spectral selection');
    for (const {component} of scan) {
      if (component.coverage[0] !== (ah ? ah : -1)) throw jpegError(ah ? 'a refinement scan out of order' : 'a DC scan twice');
      component.coverage[0] = al;
    }
    return;
  }
  if (scan.length !== 1) throw jpegError('an interleaved AC scan');
  if (se > 63 || ss > se) throw jpegError('a bad spectral selection');
  const {coverage} = scan[0].component;
  if (coverage[0] === -1) throw jpegError('an AC scan before the DC scan');
  for (let k = ss; k <= se; k++) {
    if (coverage[k] !== (ah ? ah : -1)) throw jpegError(ah ? 'a refinement scan out of order' : 'a band coded twice');
    coverage[k] = al;
  }
}

class ScanReader {
  constructor(bytes, start, frame, scan, ss, se, ah, al, choices) {
    this.bytes = bytes; this.pos = start; this.clean = new Uint8Array(0); this.bit = 0; this.limit = 0;
    this.scan = scan; this.ss = ss; this.se = se; this.ah = ah; this.al = al; this.choices = choices;
    this.progressive = frame.progressive; this.eobrun = -1; this.blockIndex = 0;
    this.mode = !this.progressive ? 0 : ss === 0 ? (ah === 0 ? 1 : 2) : (ah === 0 ? 3 : 4);
  }
  load() {
    const bytes = this.bytes;
    let end = this.pos;
    while (end < bytes.length && !(bytes[end] === 0xFF && bytes[end + 1] !== 0 && bytes[end + 1] !== 0xFF)) end++;
    if (this.clean.length < end - this.pos + 4) this.clean = new Uint8Array(end - this.pos + 4);
    const clean = this.clean;
    let n = 0, pos = this.pos;
    while (pos < bytes.length) {
      const byte = bytes[pos];
      if (byte === 0xFF) {
        const next = bytes[pos + 1];
        if (next === 0) { clean[n++] = 0xFF; pos += 2; continue; }
        if (next === 0xFF) { pos++; continue; }
        break;
      }
      clean[n++] = byte; pos++;
    }
    clean.fill(0, n, n + 4); this.pos = pos; this.bit = 0; this.limit = n * 8;
  }
  window() { const clean = this.clean, bit = this.bit, at = bit >>> 3; return ((clean[at] << 24 | clean[at + 1] << 16 | clean[at + 2] << 8 | clean[at + 3]) << (bit & 7)) >>> 0; }
  receive(n) {
    if (!n) return 0;
    if (this.bit + n > this.limit) throw jpegError('a scan cut short');
    const value = this.window() >>> (32 - n); this.bit += n; return value;
  }
  decode(table) {
    if (!table) throw jpegError('a scan without its Huffman table');
    const entry = table[this.window() >>> 16];
    if (!entry) throw jpegError('bad Huffman code');
    if (this.bit + (entry >> 8) > this.limit) throw jpegError('a scan cut short');
    this.bit += entry >> 8;
    return entry & 255;
  }
  atMarker(final = false) {
    const remaining = this.limit - this.bit, padding = remaining & 7, fill = remaining >>> 3, bytes = this.bytes;
    if (fill) {
      if (!final || this.clean.subarray((this.bit + 7) >>> 3, this.limit >>> 3).some(byte => byte !== 255)) throw jpegError('bytes left over in a scan');
      if (this.choices) this.choices.fill = fill;
    }
    if (this.eobrun > 0) throw jpegError('an end-of-band run past its interval');
    if (padding && (this.window() >>> (32 - padding)) !== (1 << padding) - 1) throw jpegError('bad scan padding');
    while (this.pos + 1 < bytes.length && bytes[this.pos] === 0xFF && bytes[this.pos + 1] === 0xFF) this.pos++;
  }
  restart(index) {
    this.atMarker();
    if (!(this.bytes[this.pos] === 0xFF && this.bytes[this.pos + 1] === 0xD0 + (index & 7))) throw jpegError('a restart marker missing or out of order');
    this.pos += 2; this.load();
    for (const s of this.scan) s.component.pred = 0;
    this.eobrun = -1;
  }
  dcValue(s, t) {
    if (t > 11) throw jpegError('a DC value out of range');
    const diff = t ? extend(this.receive(t), t) : 0;
    s.component.pred += diff;
    if (s.component.pred > 2047 || s.component.pred < -2048) throw jpegError('a DC value out of range');
    return s.component.pred;
  }
  acValue(size, shift) {
    if (size > 10) throw jpegError('an AC value out of range');
    const value = extend(this.receive(size), size) * (1 << shift);
    if (value > 1023 || value < -1023) throw jpegError('an AC value out of range');
    return value;
  }
  block(s, coeffs, at) {
    switch (this.mode) {
      case 0: coeffs[at] = this.dcValue(s, this.decode(s.dc)); this.acFirst(s, coeffs, at); break;
      case 1: {
        const value = this.dcValue(s, this.decode(s.dc)) * (1 << this.al);
        if (value > 2047 || value < -2048) throw jpegError('a DC value out of range');
        coeffs[at] = value; break;
      }
      case 2: if (this.receive(1)) coeffs[at] |= 1 << this.al; break;
      case 3: this.acFirst(s, coeffs, at); break;
      default: this.acRefine(s, coeffs, at);
    }
    this.blockIndex++;
  }
  pastBand() { return jpegError('coefficients past the ' + (this.progressive ? 'band' : 'block')); }
  acFirst(s, coeffs, at) {
    if (this.eobrun > 0) { this.eobrun--; return; }
    const ended = this.eobrun === 0, {ss, se, al, progressive, choices} = this;
    this.eobrun = -1;
    let zeroRuns = 0;
    for (let k = ss || 1; k <= se;) {
      const rs = this.decode(s.ac), r = rs >> 4, size = rs & 15;
      if (!size) {
        if (r < 15) {
          if (r && !progressive) throw jpegError('an end-of-band run in a sequential scan');
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
        if (size) { if (size !== 1) throw jpegError('a bad refinement code'); value = this.receive(1) ? p1 : m1; }
        else if (r !== 15) { if (k === ss && ended) choices?.resets.push(this.blockIndex); this.eobrun = 1 << r; if (r) this.eobrun += this.receive(r); break; }
        for (; k <= se; k++) {
          const z = at + ZIGZAG[k];
          if (coeffs[z] !== 0) { if (this.receive(1) && (coeffs[z] & p1) === 0) coeffs[z] += coeffs[z] >= 0 ? p1 : m1; }
          else if (--r < 0) break;
        }
        if (r >= 0 || (value && k > se)) throw jpegError('coefficients past the band');
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

function decodeScan(bytes, start, frame, scan, ss, se, ah, al, restartInterval, choices) {
  admitScan(frame, scan, ss, se, ah, al);
  const single = scan.length === 1, first = scan[0].component;
  const total = single ? first.blocksW * first.blocksH : frame.mcusX * frame.mcusY;
  let pos;
  const decoded = frame.progressive ? null : kernelHooks.entropy?.()?.sequentialDecode(bytes, start, frame, scan, restartInterval, ZIGZAG);
  if (decoded) {
    pos = decoded.pos;
    if (choices) for (const [block, count] of decoded.zeros) choices.zeros.push({block, count});
  } else {
    const reader = new ScanReader(bytes, start, frame, scan, ss, se, ah, al, choices);
    for (const s of scan) s.component.pred = 0;
    reader.load();
    for (let unit = 0; unit < total; unit++) {
      if (restartInterval && unit > 0 && unit % restartInterval === 0) reader.restart(unit / restartInterval - 1);
      if (single) {
        const by = (unit / first.blocksW) | 0, bx = unit - by * first.blocksW;
        reader.block(scan[0], first.coeffs, (by * first.stride + bx) * 64);
      } else {
        const my = (unit / frame.mcusX) | 0, mx = unit - my * frame.mcusX;
        for (const s of scan) {
          const c = s.component;
          for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) reader.block(s, c.coeffs, ((my * c.v + v) * c.stride + mx * c.h + h) * 64);
        }
      }
    }
    reader.atMarker(true);
    pos = reader.pos;
  }
  if (bytes[pos] === 0xFF && bytes[pos + 1] >= 0xD0 && bytes[pos + 1] <= 0xD7) {
    if (!restartInterval || total % restartInterval || bytes[pos + 1] !== 0xD0 + ((total / restartInterval - 1) & 7)) throw jpegError('a restart marker out of order');
    if (choices) choices.finalRestart = bytes[pos + 1];
    pos += 2;
    while (pos + 1 < bytes.length && bytes[pos] === 0xFF && bytes[pos + 1] === 0xFF) pos++;
  }
  if (pos < bytes.length && !(bytes[pos] === 0xFF && pos + 1 < bytes.length && bytes[pos + 1] !== 0 && bytes[pos + 1] !== 0xFF)) throw jpegError('bytes left over after a scan');
  return pos;
}
