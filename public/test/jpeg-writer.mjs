// SPDX-License-Identifier: MIT
// A JPEG writer from coefficients for the tests (never shipped): baseline or progressive scans, any sampling, optional restart intervals.
// Standard Huffman tables (Annex K) so every symbol has a code.
import {ZIGZAG} from '../../jfif.mjs';
const DC_LUMA = [[0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]];
const AC_LUMA_COUNTS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_LUMA_SYMBOLS = [0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa];
// The AC table lacks the progressive EOBn symbols (0x10..0xE0); add a table that has every symbol for progressive scans.
function fullAcTable() { const symbols = []; for (let r = 0; r < 16; r++) for (let s = 0; s < 16; s++) symbols.push((r << 4) | s); const counts = [0, 0, 0, 0, 0, 0, 0, 0, 255, 1, 0, 0, 0, 0, 0, 0]; return [counts, symbols]; }
function codesOf([counts, symbols]) { const map = new Map(); let code = 0, k = 0; for (let len = 1; len <= 16; len++) { for (let i = 0; i < counts[len - 1]; i++) map.set(symbols[k++], [len, code++]); code <<= 1; } return map; }
class Bits { constructor() { this.out = []; this.acc = 0; this.n = 0; } write(len, value) { for (let i = len - 1; i >= 0; i--) { this.acc = (this.acc << 1) | ((value >> i) & 1); if (++this.n === 8) { this.out.push(this.acc); if (this.acc === 0xFF) this.out.push(0); this.acc = 0; this.n = 0; } } } flush() { while (this.n) this.write(1, 1); } }
const size = v => { v = Math.abs(v); let n = 0; while (v) { n++; v >>= 1; } return n; };
const bitsOf = (v, n) => v >= 0 ? v : v + (1 << n) - 1;
function segment(marker, payload) { return [0xFF, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255, ...payload]; }

// components: [{h, v, quant: Int32Array(64) natural, blocksW, blocksH, coeffs: Int16Array(stride*rows*64), stride, rows}]
export function writeJPEG({width, height, components, progressive = false, restartInterval = 0, jfif = true}) {
  const out = [0xFF, 0xD8];
  if (jfif) out.push(...segment(0xE0, [0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]));
  components.forEach((c, i) => { const q = []; for (let k = 0; k < 64; k++) q.push(c.quant[ZIGZAG[k]]); out.push(...segment(0xDB, [i, ...q])); });
  const sof = [8, height >> 8, height & 255, width >> 8, width & 255, components.length];
  components.forEach((c, i) => sof.push(i + 1, (c.h << 4) | c.v, i));
  out.push(...segment(progressive ? 0xC2 : 0xC0, sof));
  const dcTable = DC_LUMA, acTable = progressive ? fullAcTable() : [AC_LUMA_COUNTS, AC_LUMA_SYMBOLS];
  out.push(...segment(0xC4, [0x00, ...dcTable[0], ...dcTable[1]]), ...segment(0xC4, [0x10, ...acTable[0], ...acTable[1]]));
  if (restartInterval) out.push(...segment(0xDD, [restartInterval >> 8, restartInterval & 255]));
  const dc = codesOf(dcTable), ac = codesOf(acTable);
  const hmax = Math.max(...components.map(c => c.h)), vmax = Math.max(...components.map(c => c.v));
  const mcusX = Math.ceil(width / (8 * hmax)), mcusY = Math.ceil(height / (8 * vmax));
  const scan = (comps, ss, se, ah, al) => {
    const header = [comps.length]; for (const c of comps) header.push(components.indexOf(c) + 1, 0x00); header.push(ss, se, (ah << 4) | al);
    out.push(...segment(0xDA, header));
    const bits = new Bits(); let eobrun = 0, restarts = 0;
    const preds = new Map(comps.map(c => [c, 0]));
    const pendingCorrections = [];
    const flushEob = () => { if (!eobrun) return; let r = 0; while ((1 << (r + 1)) <= eobrun) r++; const [len, code] = ac.get(r << 4); bits.write(len, code); if (r) bits.write(r, eobrun - (1 << r)); eobrun = 0; for (const b of pendingCorrections) bits.write(1, b); pendingCorrections.length = 0; };
    const block = (c, at) => {
      const co = c.coeffs;
      if (ss === 0) {
        const value = co[at] >> al;
        if (ah === 0) { const diff = value - preds.get(c); preds.set(c, value); const n = size(diff); const [len, code] = dc.get(n); bits.write(len, code); if (n) bits.write(n, bitsOf(diff, n)); }
        else bits.write(1, (co[at] >> al) & 1);
        if (progressive) return;
      }
      const first = progressive ? ss : 1, last = progressive ? se : 63;
      if (!progressive || ah === 0) {
        let run = 0;
        for (let k = first; k <= last; k++) {
          const v = progressive ? (co[at + ZIGZAG[k]] / (1 << al)) | 0 : co[at + ZIGZAG[k]];
          const value = progressive ? Math.trunc(co[at + ZIGZAG[k]] / (1 << al)) : v;
          if (value === 0) { run++; continue; }
          flushEob();
          while (run >= 16) { const [len, code] = ac.get(0xF0); bits.write(len, code); run -= 16; }
          const n = size(value), [len, code] = ac.get((run << 4) | n); bits.write(len, code); bits.write(n, bitsOf(value, n)); run = 0;
        }
        if (run) { if (progressive) { eobrun++; if (eobrun === 0x7FFF) flushEob(); } else { const [len, code] = ac.get(0x00); bits.write(len, code); } }
        return;
      }
      // Refinement, as libjpeg writes it: ZRLs go out at the first nonzero coefficient once 16 zeros have passed
      // (and only when a new coefficient still follows), each ZRL followed by the correction bits buffered so far.
      const p1 = 1 << al;
      let run = 0, corrections = [], lastNew = -1;
      for (let k = ss; k <= se; k++) if (Math.abs(Math.trunc(co[at + ZIGZAG[k]] / p1)) === 1) lastNew = k;
      for (let k = ss; k <= se; k++) {
        const v = Math.trunc(co[at + ZIGZAG[k]] / p1), a = Math.abs(v);
        if (a === 0) { run++; continue; }
        while (run > 15 && k <= lastNew) {
          flushEob();
          const [len, code] = ac.get(0xF0); bits.write(len, code); run -= 16;
          for (const b of corrections) bits.write(1, b); corrections = [];
        }
        if (a > 1) { corrections.push(a & 1); continue; }
        flushEob();
        const [len, code] = ac.get((run << 4) | 1); bits.write(len, code); bits.write(1, v > 0 ? 1 : 0);
        for (const b of corrections) bits.write(1, b); corrections = []; run = 0;
      }
      if (run > 0 || corrections.length) { eobrun++; pendingCorrections.push(...corrections); if (eobrun === 0x7FFF || pendingCorrections.length > 900) flushEob(); }
    };
    const flushAll = () => flushEob();
    const single = comps.length === 1, total = single ? comps[0].blocksW * comps[0].blocksH : mcusX * mcusY;
    for (let unit = 0; unit < total; unit++) {
      if (restartInterval && unit > 0 && unit % restartInterval === 0) { flushAll(); bits.flush(); bits.out.push(0xFF, 0xD0 + (restarts++ & 7)); for (const c of comps) preds.set(c, 0); }
      if (single) { const c = comps[0], by = (unit / c.blocksW) | 0, bx = unit % c.blocksW; block(c, (by * c.stride + bx) * 64); }
      else { const my = (unit / mcusX) | 0, mx = unit % mcusX; for (const c of comps) for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) block(c, ((my * c.v + v) * c.stride + mx * c.h + h) * 64); }
    }
    flushAll(); bits.flush(); for (const byte of bits.out) out.push(byte);
  };
  if (!progressive) scan(components, 0, 63, 0, 0);
  else {
    scan(components, 0, 0, 0, 1);            // DC first, one bit dropped
    for (const c of components) scan([c], 1, 5, 0, 2);
    for (const c of components) scan([c], 6, 63, 0, 2);
    for (const c of components) scan([c], 1, 63, 2, 1);
    scan(components, 0, 0, 1, 0);            // DC refinement
    for (const c of components) scan([c], 1, 63, 1, 0);
  }
  out.push(0xFF, 0xD9);
  return Uint8Array.from(out);
}
