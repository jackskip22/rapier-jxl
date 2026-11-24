// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {ensureKernels} from './kernels.mjs';
import {kernelInstance, arenaHolder, takeArena, growArena} from './kernel-runtime.mjs';
import {TRANSFORMS} from './vardct-bases.mjs';

const cl = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v) | 0;
const hU = (a, sh) => ((a + (1 << (sh - 1))) | 0) >> sh;

export const OPSIN_LUT = new Int32Array(256);
for (let i = 0, m = 0; i < 256; i++) {
  while (511 * (2 * m + 1) ** 3 <= 2 ** 33 * (2 * i + 1)) m++;
  OPSIN_LUT[i] = m;
}

export function visualLexerGlobalInput(sums, cells, sky, ramp, texture, qIntent, wide) {
  const count = Math.max(1, cells), input = new Int32Array(16);
  for (let k = 0; k < 11; k++) input[k] = Math.floor(sums[k] / count);
  input[11] = Math.floor(sky * 8192 / count);
  input[12] = Math.floor(ramp * 8192 / count);
  input[13] = Math.floor(texture * 8192 / count);
  input[14] = Math.max(0, Math.min(8192, qIntent | 0));
  input[15] = wide ? 4096 : 0;
  return input;
}

export function visualLexerGlobalInputV2(sums, cells, sky, ramp, texture, qIntent, wide, sum64Y, n64, sum256Y, n256) {
  const base = visualLexerGlobalInput(sums, cells, sky, ramp, texture, qIntent, wide);
  const input = new Int32Array(20);
  input.set(base, 0);
  const c = Math.max(1, cells) >>> 0;
  const msb = (31 - Math.clz32(c)) | 0;
  const mant8 = msb >= 8 ? ((c >>> (msb - 8)) & 255) : ((c << (8 - msb)) & 255);
  const log2x256 = (msb << 8) | mant8;
  input[16] = cl(Math.imul(log2x256 - 2048, 3), 0, 8192);
  input[17] = Math.floor(sum64Y / Math.max(1, n64));
  input[18] = Math.floor(sum256Y / Math.max(1, n256));
  const actMean = (input[1] + input[2]) | 0;
  const denom = (input[17] + 64) >>> 0;
  input[19] = cl((((actMean << 10) >>> 0) / denom) | 0, 0, 8192);
  return input;
}

export function extractVisualLexemes8(rgba, width, height, bw, bh, qIntentInt) {
  const out = new Int32Array(bw * bh * 12);
  const cx = x => x < 0 ? 0 : x >= width ? width - 1 : x;
  const cy = y => y < 0 ? 0 : y >= height ? height - 1 : y;
  const pxOff = (x, y) => (cy(y) * width + cx(x)) << 2;
  const opY = (x, y) => {
    const o = pxOff(x, y);
    return ((OPSIN_LUT[rgba[o]] * 3 + (OPSIN_LUT[rgba[o + 1]] << 3) + OPSIN_LUT[rgba[o + 2]]) >> 2) | 0;
  };
  const opXB = (x, y) => {
    const o = pxOff(x, y), r = OPSIN_LUT[rgba[o]], g = OPSIN_LUT[rgba[o + 1]], b = OPSIN_LUT[rgba[o + 2]];
    return [(r - g) | 0, (b - ((r + g) >> 1)) | 0];
  };
  const qClamped = cl(qIntentInt | 0, 0, 8192);

  for (let by = 0; by < bh; by++) {
    const y0 = by << 3;
    for (let bx = 0; bx < bw; bx++) {
      const x0 = bx << 3;
      let sumY = 0, ugx = 0, ugy = 0, sgx = 0, sgy = 0, lap = 0, chAbs = 0, chGrad = 0;
      let yMin = 3072, yMax = 0, q0 = 0, q1 = 0, q2 = 0, q3 = 0;
      for (let dy = 0; dy < 8; dy++) {
        const y = y0 + dy, top = dy < 4;
        for (let dx = 0; dx < 8; dx++) {
          const x = x0 + dx, o = pxOff(x, y);
          const r = OPSIN_LUT[rgba[o]], g = OPSIN_LUT[rgba[o + 1]], b = OPSIN_LUT[rgba[o + 2]];
          const yc = ((r * 3 + (g << 3) + b) >> 2) | 0;
          const xc = (r - g) | 0, bc = (b - ((r + g) >> 1)) | 0;
          const yx = (opY(x + 1, y) - yc) | 0, yy = (opY(x, y + 1) - yc) | 0;
          const lpv = Math.abs(((yc << 2) - opY(x - 1, y) - opY(x + 1, y) - opY(x, y - 1) - opY(x, y + 1)) | 0) | 0;
          const [xr, br] = opXB(x + 1, y), [xd, bd] = opXB(x, y + 1);
          const ax = Math.abs(yx) | 0, ay = Math.abs(yy) | 0;
          sumY = (sumY + yc) | 0;
          ugx = (ugx + ax) | 0;
          ugy = (ugy + ay) | 0;
          sgx = (sgx + yx) | 0;
          sgy = (sgy + yy) | 0;
          lap = (lap + lpv) | 0;
          chAbs = (chAbs + Math.abs(xc) + Math.abs(bc)) | 0;
          chGrad = (chGrad + Math.abs(xr - xc) + Math.abs(br - bc) + Math.abs(xd - xc) + Math.abs(bd - bc)) | 0;
          if (yc < yMin) yMin = yc;
          if (yc > yMax) yMax = yc;
          const gxy = (ax + ay) | 0;
          if (top) {
            if (dx < 4) q0 = (q0 + gxy) | 0;
            else q1 = (q1 + gxy) | 0;
          } else {
            if (dx < 4) q2 = (q2 + gxy) | 0;
            else q3 = (q3 + gxy) | 0;
          }
        }
      }
      const qMax = Math.max(q0, q1, q2, q3) | 0, qMin = Math.min(q0, q1, q2, q3) | 0;
      const netS = (Math.abs(sgx) + Math.abs(sgy)) | 0;
      const totG32 = (ugx + ugy + 32) >>> 0, totG64 = (ugx + ugy + 64) >>> 0;
      const dst = (by * bw + bx) * 12;
      out[dst + 0] = cl((((sumY + 12) >>> 0) / 24) | 0, 0, 8192);
      out[dst + 1] = cl(ugx >> 2, 0, 8192);
      out[dst + 2] = cl(ugy >> 2, 0, 8192);
      out[dst + 3] = cl(((Math.imul(netS, 8192) >>> 0) / totG32) | 0, 0, 8192);
      out[dst + 4] = cl(lap >> 3, 0, 8192);
      out[dst + 5] = cl(((Math.imul(lap, 2048) >>> 0) / totG64) | 0, 0, 8192);
      out[dst + 6] = cl((qMax - qMin) >> 1, 0, 8192);
      const diffG = (ugx - ugy) | 0;
      const anisoTerm = diffG >= 0 ? (((Math.imul(diffG, 4096) >>> 0) / totG64) | 0) : -(((Math.imul(-diffG, 4096) >>> 0) / totG64) | 0);
      out[dst + 7] = cl(4096 + anisoTerm, 0, 8192);
      out[dst + 8] = cl(chAbs >> 3, 0, 8192);
      out[dst + 9] = cl(chGrad >> 3, 0, 8192);
      out[dst + 10] = cl((yMax - yMin) << 1, 0, 8192);
      out[dst + 11] = qClamped;
    }
  }
  return out;
}

export const VISUAL_LEXER_VERSION = 1;
export const VISUAL_LEXER_V2 = 2;

export function parseVisualLexerPacket(pkt) {
  if (!(pkt instanceof Uint8Array) || pkt.byteLength < 32 || pkt[0] !== 0 || pkt[1] !== 0x56 ||
      (pkt[2] !== 1 && pkt[2] !== 2) || pkt[2] === 2 && pkt.byteLength < 40)
    throw fault('JXL_INTERNAL', 'visual-lexer:packet');
  const version = pkt[2], shift = version === 2 ? 8 : 0, dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  return {
    version, C: pkt[3], offG: dv.getUint32(4, true),
    ...(shift && {off256: dv.getUint32(8, true), off128: dv.getUint32(12, true)}),
    off64: dv.getUint32(8 + shift, true), off32: dv.getUint32(12 + shift, true),
    off16: dv.getUint32(16 + shift, true), off8: dv.getUint32(20 + shift, true),
    readLine: dv.getUint16(24 + shift, true), minEdge: shift ? dv.getUint16(34, true) : 0,
  };
}

export function visualLexerPacketShape(pkt) {
  const parsed = parseVisualLexerPacket(pkt);
  const {version, C} = parsed, v2 = version === 2;
  const bad = what => { throw fault('JXL_INTERNAL', 'visual-lexer:shape:' + what); };
  if (C < 1 || C > (v2 ? 96 : 112)) bad('C');
  for (let i = v2 ? 36 : 26; i < (v2 ? 40 : 32); i++) if (pkt[i] !== 0) bad('reserved');
  const {subpackets} = verifyVisualLexerFanIn(pkt);
  const want = {
    offG: [v2 ? 20 : 16, [v2 ? 6 + C : 6]], off64: [v2 ? 16 + C : 16, [v2 ? C : C + 4]],
    off32: [16 + C, [C + 4]], off16: [16 + C, v2 ? [C + 8] : [C + 4, C + 8]], off8: [16 + C, [v2 ? 2 : 8]],
    off256: [16 + C, [C]], off128: [16 + C, [C]],
  };
  for (const [name, {d, n1, n2, no, s1, s2, s1b}] of Object.entries(subpackets)) {
    const [inputs, outputs] = want[name];
    if (d !== inputs || !outputs.includes(no) || n1 < 1 || (s1b && !n2) || s1 < 1 || s1 > 30 || s2 < 1 || s2 > 30) bad(name);
  }
  return {...parsed, subpackets};
}

export function verifyVisualLexerFanIn(pkt) {
  const parsed = parseVisualLexerPacket(pkt);
  const wv = new Int8Array(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  const INT32_MAX = 2147483647;
  let worstBound = 0;
  const subpackets = {};
  const entries = Object.entries(parsed).filter(([name]) => name.startsWith('off'));
  const minOff = parsed.version === 1 ? 32 : 40;
  for (const [name, off] of entries) {
    if ((off & 1) || off < minOff || off + 8 > pkt.byteLength) throw fault('JXL_INTERNAL', 'visual-lexer:subpacket:' + name);
    if (pkt[off] > 30 || pkt[off + 1] !== 0x4d) throw fault('JXL_INTERNAL', 'visual-lexer:subpacket:' + name);
    const d = pkt[off + 2], n1 = pkt[off + 3], n2 = pkt[off + 4], no = pkt[off + 5], s1 = pkt[off + 6], s2 = pkt[off + 7], s1b = pkt[off] || s1;
    const w1 = off + 8, w2 = w1 + n1 * d, lastH = n2 > 0 ? n2 : n1, wo = w2 + n2 * n1;
    const b1 = off + ((8 + n1 * d + n2 * n1 + no * lastH + 1) & ~1), b2 = b1 + n1 * 2, bo = b2 + n2 * 2;
    if (bo + no * 2 > pkt.byteLength) throw fault('JXL_INTERNAL', 'visual-lexer:subpacket:' + name);
    let subWorst = 0;
    const checkRows = (wOff, bOff, rows, cols, xMax, sh) => {
      const half = 1 << (sh - 1);
      for (let i = 0; i < rows; i++) {
        let rowAbs = Math.abs(dv.getInt16(bOff + i * 2, true) << 6) + half;
        for (let j = 0; j < cols; j++) {
          const w = wv[wOff + i * cols + j];
          if (w === -128) throw fault('JXL_INTERNAL', 'visual-lexer:weight-128:' + name);
          rowAbs += Math.abs(w) * xMax;
        }
        if (rowAbs >= INT32_MAX) throw fault('JXL_INTERNAL', 'visual-lexer:overflow:' + name);
        if (rowAbs > subWorst) subWorst = rowAbs;
        if (rowAbs > worstBound) worstBound = rowAbs;
      }
    };
    checkRows(w1, b1, n1, d, 8192, s1);
    if (n2 > 0) checkRows(w2, b2, n2, n1, 1024, s1b);
    checkRows(wo, bo, no, lastH, 1024, s2);
    subpackets[name] = {d, n1, n2, no, s1, s2, s1b: pkt[off], maxAccumulatorBound: subWorst};
  }
  return {verified: true, maxAccumulatorBound: worstBound, headroomRatio: Number((INT32_MAX / Math.max(1, worstBound)).toFixed(2)), subpackets};
}

export function evalVisualLexerInt32(pkt, feat8, bw, bh, qIntent, wide) {
  const parsed = parseVisualLexerPacket(pkt);
  const {version, C, offG, off64, off32, off16, off8} = parsed;
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  const wv = new Int8Array(pkt.buffer, pkt.byteOffset, pkt.byteLength);

  const mlp = (off, x) => {
    const d = pkt[off + 2], n1 = pkt[off + 3], n2 = pkt[off + 4], no = pkt[off + 5], s1 = pkt[off + 6], s2 = pkt[off + 7], s1b = pkt[off] || s1;
    const w1 = off + 8, w2 = w1 + n1 * d, lastH = n2 > 0 ? n2 : n1, wo = w2 + n2 * n1;
    const b1 = off + ((8 + n1 * d + n2 * n1 + no * lastH + 1) & ~1), b2 = b1 + n1 * 2, bo = b2 + n2 * 2;
    let prev = new Int32Array(n1);
    for (let i = 0; i < n1; i++) {
      let a = (dv.getInt16(b1 + i * 2, true) << 6) | 0;
      for (let j = 0; j < d; j++) a = (a + Math.imul(wv[w1 + i * d + j], cl(x[j], -32767, 32767))) | 0;
      prev[i] = cl(hU(a, s1), 0, 1024);
    }
    if (n2 > 0) {
      const h2 = new Int32Array(n2);
      for (let i = 0; i < n2; i++) {
        let a = (dv.getInt16(b2 + i * 2, true) << 6) | 0;
        for (let j = 0; j < n1; j++) a = (a + Math.imul(wv[w2 + i * n1 + j], prev[j])) | 0;
        h2[i] = cl(hU(a, s1b), 0, 1024);
      }
      prev = h2;
    }
    const o = new Int32Array(no);
    for (let m = 0; m < no; m++) {
      let a = (dv.getInt16(bo + m * 2, true) << 6) | 0;
      for (let j = 0; j < lastH; j++) a = (a + Math.imul(wv[wo + m * lastH + j], prev[j])) | 0;
      o[m] = hU(a, s2);
    }
    return o;
  };

  const n8 = bw * bh;
  const aug8 = new Int32Array(n8 * 16);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = y * bw + x, s = i * 12, d = i * 16;
      for (let k = 0; k < 12; k++) aug8[d + k] = feat8[s + k] | 0;
      let sumAct = 0, minAct = 8192, maxRng = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy < 0 ? 0 : y + dy >= bh ? bh - 1 : y + dy;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx < 0 ? 0 : x + dx >= bw ? bw - 1 : x + dx;
          const nb = (ny * bw + nx) * 12;
          const act = cl((feat8[nb + 1] + feat8[nb + 2]) | 0, 0, 8192);
          const rng = feat8[nb + 10] | 0;
          sumAct = (sumAct + act) | 0;
          if (act < minAct) minAct = act;
          if (rng > maxRng) maxRng = rng;
        }
      }
      aug8[d + 12] = (((sumAct + 4) >>> 0) / 9) | 0;
      aug8[d + 13] = minAct;
      aug8[d + 14] = maxRng;
      aug8[d + 15] = cl((maxRng - minAct) | 0, 0, 8192);
    }
  }

  const poolScale = (child, cw, ch) => {
    const pw = (cw + 1) >> 1, ph = (ch + 1) >> 1;
    const p = new Int32Array(pw * ph * 16);
    for (let py = 0; py < ph; py++) {
      for (let px = 0; px < pw; px++) {
        let yMin = 8192, yMax = 0, aMin = 8192, aMax = 0, maxRng = 0, sum11 = 2;
        const sums = new Int32Array(10).fill(2);
        for (let dy = 0; dy < 2; dy++) {
          const cy = (py << 1) + dy < ch ? (py << 1) + dy : ch - 1;
          for (let dx = 0; dx < 2; dx++) {
            const cx = (px << 1) + dx < cw ? (px << 1) + dx : cw - 1;
            const cb = (cy * cw + cx) * 16;
            const yv = child[cb] | 0;
            if (yv < yMin) yMin = yv;
            if (yv > yMax) yMax = yv;
            for (let k = 1; k <= 9; k++) sums[k] = (sums[k] + child[cb + k]) | 0;
            if (child[cb + 10] > maxRng) maxRng = child[cb + 10] | 0;
            sum11 = (sum11 + child[cb + 11]) | 0;
            const act = cl((child[cb + 1] + child[cb + 2]) | 0, 0, 8192);
            if (act < aMin) aMin = act;
            if (act > aMax) aMax = act;
          }
        }
        const pd = (py * pw + px) * 16;
        p[pd + 0] = cl((yMax - yMin) | 0, 0, 8192);
        for (let k = 1; k <= 9; k++) p[pd + k] = sums[k] >> 2;
        p[pd + 10] = maxRng;
        p[pd + 11] = sum11 >> 2;
        p[pd + 12] = cl((aMax - aMin) | 0, 0, 8192);
      }
    }
    for (let py = 0; py < ph; py++) {
      for (let px = 0; px < pw; px++) {
        let sumAct = 0, minAct = 8192, maxRng = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = py + dy < 0 ? 0 : py + dy >= ph ? ph - 1 : py + dy;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx < 0 ? 0 : px + dx >= pw ? pw - 1 : px + dx;
            const nb = (ny * pw + nx) * 16;
            const pa = cl((p[nb + 1] + p[nb + 2]) | 0, 0, 8192);
            const pr = p[nb + 10] | 0;
            sumAct = (sumAct + pa) | 0;
            if (pa < minAct) minAct = pa;
            if (pr > maxRng) maxRng = pr;
          }
        }
        const pd = (py * pw + px) * 16;
        p[pd + 13] = minAct;
        p[pd + 14] = maxRng;
        p[pd + 15] = (((sumAct + 4) >>> 0) / 9) | 0;
      }
    }
    return {data: p, pw, ph};
  };

  const lv16 = poolScale(aug8, bw, bh);
  const lv32 = poolScale(lv16.data, lv16.pw, lv16.ph);
  const lv64 = poolScale(lv32.data, lv32.pw, lv32.ph);

  const gSum = new Float64Array(11);
  let skyCnt = 0, rampCnt = 0, texCnt = 0;
  for (let i = 0; i < n8; i++) {
    const b = i * 16;
    for (let k = 0; k <= 10; k++) gSum[k] += aug8[b + k];
    const e = (aug8[b + 1] + aug8[b + 2]) | 0, rc = aug8[b + 3] | 0, lp = aug8[b + 4] | 0, hf = aug8[b + 5] | 0;
    if (e < 180 && lp < 160) skyCnt++;
    if (e < 600 && rc > 3200 && lp < 300) rampCnt++;
    if (e > 900 && hf > 1800) texCnt++;
  }
  if (version === 2) {
    const lv128 = poolScale(lv64.data, lv64.pw, lv64.ph);
    const lv256 = poolScale(lv128.data, lv128.pw, lv128.ph);
    const n64 = lv64.pw * lv64.ph, n256 = lv256.pw * lv256.ph;
    let sum64Y = 0, sum256Y = 0;
    for (let i = 0; i < n64; i++) sum64Y += lv64.data[i * 16];
    for (let i = 0; i < n256; i++) sum256Y += lv256.data[i * 16];
    const gIn = visualLexerGlobalInputV2(gSum, n8, skyCnt, rampCnt, texCnt, qIntent, wide, sum64Y, n64, sum256Y, n256);
    const gOut = mlp(offG, gIn);
    const gCtx = new Int32Array(C);
    for (let k = 0; k < C; k++) gCtx[k] = cl(gOut[6 + k], 0, 1024);

    const runCtx = (off, lv, par, parW) => {
      const n = lv.pw * lv.ph, dst = new Int32Array(n * C), inp = new Int32Array(16 + C);
      for (let y = 0; y < lv.ph; y++) {
        for (let x = 0; x < lv.pw; x++) {
          const i = y * lv.pw + x, p = parW > 0 ? ((y >> 1) * parW + (x >> 1)) : 0;
          inp.set(lv.data.subarray(i * 16, i * 16 + 16), 0);
          inp.set(par.subarray(p * C, p * C + C), 16);
          const o = mlp(off, inp);
          for (let k = 0; k < C; k++) dst[i * C + k] = cl(o[k], 0, 1024);
        }
      }
      return dst;
    };

    const c256 = runCtx(parsed.off256, lv256, gCtx, 0);
    const c128 = runCtx(parsed.off128, lv128, c256, lv256.pw);
    const c64 = runCtx(off64, lv64, c128, lv128.pw);

    const c32 = new Int32Array(lv32.pw * lv32.ph * C), m32 = new Int32Array(lv32.pw * lv32.ph).fill(-1);
    const in32 = new Int32Array(16 + C);
    for (let y = 0; y < lv32.ph; y++) {
      for (let x = 0; x < lv32.pw; x++) {
        const i = y * lv32.pw + x, p = (y >> 1) * lv64.pw + (x >> 1);
        in32.set(lv32.data.subarray(i * 16, i * 16 + 16), 0);
        in32.set(c64.subarray(p * C, p * C + C), 16);
        const o = mlp(off32, in32);
        for (let k = 0; k < C; k++) c32[i * C + k] = cl(o[k], 0, 1024);
        if ((x << 2) + 4 <= bw && (y << 2) + 4 <= bh) {
          const sp = o[C], a = o[C + 1], b = o[C + 2], c = o[C + 3];
          if (Math.max(a, b, c) > sp) m32[i] = a >= b && a >= c ? 5 : (b >= c ? 10 : 11);
        }
      }
    }

    const c16 = new Int32Array(lv16.pw * lv16.ph * C), m16 = new Int32Array(lv16.pw * lv16.ph).fill(-1);
    const in16 = new Int32Array(16 + C);
    for (let y = 0; y < lv16.ph; y++) {
      for (let x = 0; x < lv16.pw; x++) {
        const i = y * lv16.pw + x, p = (y >> 1) * lv32.pw + (x >> 1);
        in16.set(lv16.data.subarray(i * 16, i * 16 + 16), 0);
        in16.set(c32.subarray(p * C, p * C + C), 16);
        const o = mlp(off16, in16);
        for (let k = 0; k < C; k++) c16[i * C + k] = cl(o[k], 0, 1024);
        if (m32[p] < 0 && (x << 1) + 2 <= bw && (y << 1) + 2 <= bh) {
          const sp = o[C], a = o[C + 1], b = o[C + 2], c = o[C + 3];
          let tid = a >= b && a >= c ? 4 : (b >= c ? 6 : 7), mx = Math.max(a, b, c);
          for (let j = 0; j < 4; j++) if (o[C + 4 + j] > mx) { mx = o[C + 4 + j]; tid = 100 + j; }
          if (mx > sp) m16[i] = tid;
        }
      }
    }

    const tGrid = new Int32Array(n8);
    const place = (bx, by, tw, th, id) => {
      for (let dy = 0; dy < th; dy++) for (let dx = 0; dx < tw; dx++) tGrid[(by + dy) * bw + bx + dx] = dx === 0 && dy === 0 ? id : -1;
    };
    for (let y = 0; y < lv32.ph; y++) for (let x = 0; x < lv32.pw; x++) {
      const m = m32[y * lv32.pw + x], bx = x << 2, by = y << 2;
      if (m === 5) place(bx, by, 4, 4, 5);
      else if (m === 10) { place(bx, by, 2, 4, 10); place(bx + 2, by, 2, 4, 10); }
      else if (m === 11) { place(bx, by, 4, 2, 11); place(bx, by + 2, 4, 2, 11); }
    }
    for (let y = 0; y < lv16.ph; y++) for (let x = 0; x < lv16.pw; x++) {
      const m = m16[y * lv16.pw + x], bx = x << 1, by = y << 1;
      if (m === 4) place(bx, by, 2, 2, 4);
      else if (m === 6) { place(bx, by, 1, 2, 6); place(bx + 1, by, 1, 2, 6); }
      else if (m === 7) { place(bx, by, 2, 1, 7); place(bx, by + 1, 2, 1, 7); }
      else if (m === 100) place(bx, by, 1, 2, 6);
      else if (m === 101) place(bx + 1, by, 1, 2, 6);
      else if (m === 102) place(bx, by, 2, 1, 7);
      else if (m === 103) place(bx, by + 1, 2, 1, 7);
    }

    const out = new Int32Array(6 + n8 * 6);
    out[0] = cl(gOut[0], -2560, 2048);
    out[1] = cl(gOut[1], -64, 154);
    out[2] = gOut[2] | 0;
    out[3] = gOut[3] | 0;
    out[4] = gOut[4] | 0;
    out[5] = cl(gOut[5], -64, 64);

    const in8 = new Int32Array(16 + C);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const i = y * bw + x, p = (y >> 1) * lv16.pw + (x >> 1);
        in8.set(aug8.subarray(i * 16, i * 16 + 16), 0);
        in8.set(c16.subarray(p * C, p * C + C), 16);
        const leaf = mlp(off8, in8), d = 6 + i * 6;
        const mrg = leaf[1] | 0;
        out[d + 0] = tGrid[i];
        out[d + 1] = 0;
        out[d + 2] = cl(leaf[0], -72, 113);
        out[d + 3] = 7;
        out[d + 4] = cl((512 + mrg) | 0, 0, 1024);
        out[d + 5] = mrg;
      }
    }
    return out;
  }

  const gIn = visualLexerGlobalInput(gSum, n8, skyCnt, rampCnt, texCnt, qIntent, wide);
  const gOut = mlp(offG, gIn);

  const c64 = new Int32Array(lv64.pw * lv64.ph * C), m64 = new Int32Array(lv64.pw * lv64.ph).fill(-1);
  for (let y = 0; y < lv64.ph; y++) {
    for (let x = 0; x < lv64.pw; x++) {
      const i = y * lv64.pw + x, o = mlp(off64, lv64.data.subarray(i * 16, i * 16 + 16));
      for (let k = 0; k < C; k++) c64[i * C + k] = cl(o[k], 0, 1024);
      if ((x << 3) + 8 <= bw && (y << 3) + 8 <= bh) {
        const sp = o[C], a = o[C + 1], b = o[C + 2], c = o[C + 3];
        if (Math.max(a, b, c) > sp) m64[i] = a >= b && a >= c ? 18 : (b >= c ? 19 : 20);
      }
    }
  }

  const c32 = new Int32Array(lv32.pw * lv32.ph * C), m32 = new Int32Array(lv32.pw * lv32.ph).fill(-1);
  const in32 = new Int32Array(16 + C);
  for (let y = 0; y < lv32.ph; y++) {
    for (let x = 0; x < lv32.pw; x++) {
      const i = y * lv32.pw + x, p = (y >> 1) * lv64.pw + (x >> 1);
      in32.set(lv32.data.subarray(i * 16, i * 16 + 16), 0);
      in32.set(c64.subarray(p * C, p * C + C), 16);
      const o = mlp(off32, in32);
      for (let k = 0; k < C; k++) c32[i * C + k] = cl(o[k], 0, 1024);
      if (m64[p] < 0 && (x << 2) + 4 <= bw && (y << 2) + 4 <= bh) {
        const sp = o[C], a = o[C + 1], b = o[C + 2], c = o[C + 3];
        if (Math.max(a, b, c) > sp) m32[i] = a >= b && a >= c ? 5 : (b >= c ? 10 : 11);
      }
    }
  }

  const c16 = new Int32Array(lv16.pw * lv16.ph * C), m16 = new Int32Array(lv16.pw * lv16.ph).fill(-1);
  const in16 = new Int32Array(16 + C);
  for (let y = 0; y < lv16.ph; y++) {
    for (let x = 0; x < lv16.pw; x++) {
      const i = y * lv16.pw + x, p = (y >> 1) * lv32.pw + (x >> 1), p64 = (y >> 2) * lv64.pw + (x >> 2);
      in16.set(lv16.data.subarray(i * 16, i * 16 + 16), 0);
      in16.set(c32.subarray(p * C, p * C + C), 16);
      const o = mlp(off16, in16);
      for (let k = 0; k < C; k++) c16[i * C + k] = cl(o[k], 0, 1024);
      if (m64[p64] < 0 && m32[p] < 0 && (x << 1) + 2 <= bw && (y << 1) + 2 <= bh) {
        const sp = o[C], a = o[C + 1], b = o[C + 2], c = o[C + 3];
        let tid = a >= b && a >= c ? 4 : (b >= c ? 6 : 7), mx = Math.max(a, b, c);
        if (pkt[off16 + 5] >= C + 8) for (let j = 0; j < 4; j++) if (o[C + 4 + j] > mx) { mx = o[C + 4 + j]; tid = 100 + j; }
        if (mx > sp) m16[i] = tid;
      }
    }
  }

  const tGrid = new Int32Array(n8);
  const place = (bx, by, tw, th, id) => {
    for (let dy = 0; dy < th; dy++) for (let dx = 0; dx < tw; dx++) tGrid[(by + dy) * bw + bx + dx] = dx === 0 && dy === 0 ? id : -1;
  };
  for (let y = 0; y < lv64.ph; y++) for (let x = 0; x < lv64.pw; x++) {
    const m = m64[y * lv64.pw + x], bx = x << 3, by = y << 3;
    if (m === 18) place(bx, by, 8, 8, 18);
    else if (m === 19) { place(bx, by, 4, 8, 19); place(bx + 4, by, 4, 8, 19); }
    else if (m === 20) { place(bx, by, 8, 4, 20); place(bx, by + 4, 8, 4, 20); }
  }
  for (let y = 0; y < lv32.ph; y++) for (let x = 0; x < lv32.pw; x++) {
    const m = m32[y * lv32.pw + x], bx = x << 2, by = y << 2;
    if (m === 5) place(bx, by, 4, 4, 5);
    else if (m === 10) { place(bx, by, 2, 4, 10); place(bx + 2, by, 2, 4, 10); }
    else if (m === 11) { place(bx, by, 4, 2, 11); place(bx, by + 2, 4, 2, 11); }
  }
  for (let y = 0; y < lv16.ph; y++) for (let x = 0; x < lv16.pw; x++) {
    const m = m16[y * lv16.pw + x], bx = x << 1, by = y << 1;
    if (m === 4) place(bx, by, 2, 2, 4);
    else if (m === 6) { place(bx, by, 1, 2, 6); place(bx + 1, by, 1, 2, 6); }
    else if (m === 7) { place(bx, by, 2, 1, 7); place(bx, by + 1, 2, 1, 7); }
    else if (m === 100) place(bx, by, 1, 2, 6);
    else if (m === 101) place(bx + 1, by, 1, 2, 6);
    else if (m === 102) place(bx, by, 2, 1, 7);
    else if (m === 103) place(bx, by + 1, 2, 1, 7);
  }

  const out = new Int32Array(6 + n8 * 6);
  out[0] = cl(gOut[0], -2560, 2048);
  out[1] = cl(gOut[1], -64, 154);
  out[2] = gOut[2] | 0;
  out[3] = gOut[3] | 0;
  out[4] = gOut[4] | 0;
  out[5] = cl(gOut[5], -64, 64);

  const tmpField = new Int32Array(n8);
  const in8 = new Int32Array(16 + C);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = y * bw + x, p = (y >> 1) * lv16.pw + (x >> 1);
      in8.set(aug8.subarray(i * 16, i * 16 + 16), 0);
      in8.set(c16.subarray(p * C, p * C + C), 16);
      const leaf = mlp(off8, in8), d = 6 + i * 6;
      let tid = tGrid[i];
      const l0 = leaf[0] | 0, l1 = leaf[1] | 0, l2 = leaf[2] | 0, l3 = leaf[3] | 0;
      const bestSub = Math.max(l1, l2, l3) | 0;
      if (tid === 0 && bestSub > l0) tid = l1 >= l2 && l1 >= l3 ? 3 : (l2 >= l3 ? 12 : 13);
      tmpField[i] = cl(leaf[4], -190, 256);
      out[d + 0] = tid;
      out[d + 2] = cl(leaf[5], -72, 113);
      out[d + 3] = cl(hU(leaf[6], 5), 0, 7);
      out[d + 4] = cl(leaf[7], 0, 1024);
      out[d + 5] = (bestSub - l0) | 0;
    }
  }

  for (let y = 0; y < bh; y++) {
    const ym = y > 0 ? y - 1 : 0, yp = y + 1 < bh ? y + 1 : bh - 1;
    for (let x = 0; x < bw; x++) {
      const xm = x > 0 ? x - 1 : 0, xp = x + 1 < bw ? x + 1 : bw - 1;
      const i = y * bw + x;
      const acc = (
        (tmpField[i] << 2) +
        ((tmpField[y * bw + xm] + tmpField[y * bw + xp] + tmpField[ym * bw + x] + tmpField[yp * bw + x]) << 1) +
        tmpField[ym * bw + xm] + tmpField[ym * bw + xp] + tmpField[yp * bw + xm] + tmpField[yp * bw + xp]
      ) | 0;
      out[6 + i * 6 + 1] = cl((acc + 8) >> 4, -190, 256);
    }
  }
  return out;
}

let vlHolder = null;
function vlScratchBytes(n8, n16, n32, n64, C, bw, bh, v2) {
  const extra = v2 ? (Math.ceil(bw / 16) * Math.ceil(bh / 16) + Math.ceil(bw / 32) * Math.ceil(bh / 32)) * (16 + C) + C : 0;
  return (
    (n8 + n16 + n32 + n64) * 16 +
    (n64 + n32 + n16) * (C + 1) +
    n8 * 2 + (16 + C) * 2 + 1024 + extra
  ) * 4 + 16384;
}

const vlLexemeScratch = bw => 60 * (((bw << 3) + 9) & ~7) + 16;

export function extractVisualLexemes8Wasm(rgba, width, height, bw, bh, qIntentInt) {
  ensureKernels();
  const {memory, exports} = kernelInstance();
  vlHolder ||= arenaHolder(() => {});
  takeArena(vlHolder);
  const n8 = bw * bh, rgbaBytes = width * height * 4, outLen = n8 * 12;
  const lutPtr = 65536;
  const rgbaPtr = lutPtr + 1024;
  const outPtr = (rgbaPtr + rgbaBytes + 15) & ~15;
  const tilePtr = (outPtr + outLen * 4 + 15) & ~15;
  const end = tilePtr + vlLexemeScratch(bw);
  if (memory.buffer.byteLength < end) growArena(end);
  new Int32Array(memory.buffer, lutPtr, 256).set(OPSIN_LUT);
  const src = rgba.byteLength === rgbaBytes ? rgba : rgba.subarray(0, rgbaBytes);
  new Uint8Array(memory.buffer, rgbaPtr, src.byteLength).set(src);
  exports.vlLexemes8(rgbaPtr, lutPtr, width | 0, height | 0, bw | 0, bh | 0, qIntentInt | 0, outPtr, tilePtr);
  return new Int32Array(memory.buffer).slice(outPtr >> 2, (outPtr >> 2) + outLen);
}

export function evalVisualLexerWasm(pkt, feat8, bw, bh, qIntent, wide) {
  if (!(pkt instanceof Uint8Array) || pkt.byteLength < 32 || pkt[1] !== 0x56)
    throw fault('JXL_INTERNAL', 'visual-lexer:packet');
  ensureKernels();
  const {memory, exports} = kernelInstance();
  vlHolder ||= arenaHolder(() => {});
  takeArena(vlHolder);
  const C = pkt[3], n8 = bw * bh, outLen = 6 + n8 * 6;
  const pw16 = (bw + 1) >> 1, ph16 = (bh + 1) >> 1, n16 = pw16 * ph16;
  const pw32 = (pw16 + 1) >> 1, ph32 = (ph16 + 1) >> 1, n32 = pw32 * ph32;
  const pw64 = (pw32 + 1) >> 1, ph64 = (ph32 + 1) >> 1, n64 = pw64 * ph64;
  const at = 65536;
  const featPtr = (at + pkt.byteLength + 15) & ~15;
  const outPtr = (featPtr + feat8.byteLength + 15) & ~15;
  const scratchPtr = (outPtr + outLen * 4 + 15) & ~15;
  const end = scratchPtr + vlScratchBytes(n8, n16, n32, n64, C, bw, bh, pkt[2] === 2);
  if (memory.buffer.byteLength < end) growArena(end);
  new Uint8Array(memory.buffer).set(pkt, at);
  const i32 = new Int32Array(memory.buffer);
  i32.set(feat8, featPtr >> 2);
  if (!exports.visualLex(at, featPtr, bw | 0, bh | 0, qIntent | 0, wide ? 1 : 0, outPtr, scratchPtr))
    throw fault('JXL_INTERNAL', 'visual-lexer:exec');
  return i32.slice(outPtr >> 2, (outPtr >> 2) + outLen);
}

export function evalVisualLexerFromRgbaWasm(pkt, rgba, width, height, qIntent, wide) {
  if (!(pkt instanceof Uint8Array) || pkt.byteLength < 32 || pkt[1] !== 0x56)
    throw fault('JXL_INTERNAL', 'visual-lexer:packet');
  const bw = Math.ceil(width / 8), bh = Math.ceil(height / 8);
  return evalVisualLexerWasm(pkt, extractVisualLexemes8Wasm(rgba, width, height, bw, bh, qIntent), bw, bh, qIntent, wide);
}

export function anchorCoderQuality(readingIntent, wide = false) {
  const r = Math.max(0.1, Math.min(0.995, readingIntent ?? 0.85));
  let q;
  if (r <= 0.75) q = 58.0 * (r / 0.75);
  else if (r <= 0.85) q = 58.0 + (r - 0.75) * 145.0;
  else if (r <= 0.92) q = 72.5 + (r - 0.85) * 185.0;
  else q = 85.45 + (r - 0.92) * 175.0;
  if (wide && r <= 0.90) q += 1.2;
  return Math.max(8, Math.min(98.5, q));
}

export function pruneRareTransforms(layout) {
  if (!layout || !layout.length) return layout;
  const counts = new Map();
  for (const b of layout) {
    const f = TRANSFORMS[b.id]?.table;
    if (f) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  const drop = new Set();
  for (const [f, c] of counts) if (c > 0 && c < 8) drop.add(f);
  if (!drop.size) return layout;
  const out = [];
  for (const b of layout) {
    const tr = TRANSFORMS[b.id];
    if (!tr || !drop.has(tr.table)) { out.push(b); continue; }
    const tw = Math.max(1, tr.width >> 3), th = Math.max(1, tr.height >> 3);
    for (let dy = 0; dy < th; dy++) for (let dx = 0; dx < tw; dx++) out.push({id: 0, bx: b.bx + dx, by: b.by + dy});
  }
  return out.sort((a, b) => (a.by - b.by) || (a.bx - b.bx));
}

const AQ_LEVELS_11 = [0.60, 0.75, 0.85, 0.95, 1.00, 1.05, 1.15, 1.30, 1.50, 1.75, 2.00];
const DZ_SCALES_5 = [0.72, 0.82, 1.00, 1.22, 1.44];
let POW2_256 = null;
function pow2Table() {
  if (POW2_256) return POW2_256;
  const t = new Float64Array(256);
  t[0] = 1;
  for (let k = 1, m = 2 ** 52; k < 256; k++) {
    const p = 1n << BigInt(53 * 256 + k);
    m = Math.round(m * 1.0027112750502025);
    while ((2n * BigInt(m) + 1n) ** 256n < p) m++;
    while ((2n * BigInt(m) - 1n) ** 256n > p) m--;
    t[k] = m / 2 ** 52;
  }
  return (POW2_256 = t);
}
const WHOLE_POW2 = [0.25, 0.5, 1, 2];
const pow2of256 = (t, e) => t[e & 255] * WHOLE_POW2[(e >> 8) + 2];

const MERGE_MARGIN = -119, GUARD_MARGIN = -100;
function splitAtEdges(layout, rawOut, bw, bh) {
  const out = [];
  let split = false;
  for (const b of layout) {
    const t = TRANSFORMS[b.id], tw = Math.max(1, t.width >> 3), th = Math.max(1, t.height >> 3);
    let calm = true;
    for (let dy = 0; dy < th && calm; dy++) for (let dx = 0; dx < tw; dx++) {
      const x = b.bx + dx, y = b.by + dy;
      if (x < bw && y < bh && (rawOut[6 + (y * bw + x) * 6 + 5] | 0) < GUARD_MARGIN) { calm = false; break; }
    }
    if (calm || tw * th === 1) { out.push(b); continue; }
    split = true;
    for (let dy = 0; dy < th; dy++) for (let dx = 0; dx < tw; dx++) if (b.bx + dx < bw && b.by + dy < bh) out.push({id: 0, bx: b.bx + dx, by: b.by + dy});
  }
  return split ? out.sort((a, c) => (a.by - c.by) || (a.bx - c.bx)) : out;
}

export function readVisualLexerVote(rawOut, n8, decoupledDeltaQ = false) {
  let hiMarginCells = 0;
  for (let i = 0; i < n8; i++) if ((rawOut[6 + i * 6 + 5] | 0) >= MERGE_MARGIN) hiMarginCells++;
  const g0 = rawOut[0] | 0, hiMarginShare = hiMarginCells / Math.max(1, n8);
  const pays = (decoupledDeltaQ || g0 >= -8) && hiMarginShare >= 0.2435;
  return {hiMarginCells, pays};
}

export function readVisualLexerConfidence(rawOut, n8, decoupledDeltaQ = false) {
  const denom = Math.max(1, n8), vote = readVisualLexerVote(rawOut, n8, decoupledDeltaQ);
  let marginSum = 0, flatSum = 0;
  for (let i = 0; i < n8; i++) {
    const off = 6 + i * 6;
    marginSum += rawOut[off + 5] | 0;
    flatSum += rawOut[off + 4] | 0;
  }
  return {
    g0: rawOut[0] | 0,
    cells: n8,
    hiMarginCells: vote.hiMarginCells,
    hiMarginShare: vote.hiMarginCells / denom,
    meanMargin: marginSum / denom,
    meanFlatness: flatSum / denom,
    pays: vote.pays,
  };
}

export function decodeVisualLexerRecipe(rawOut, width, height, readingIntent, wide, fallbackQuality, fineQuant = false) {
  const bw = Math.ceil(width / 8), bh = Math.ceil(height / 8), n8 = bw * bh;
  const anchorQ = anchorCoderQuality(readingIntent ?? (fallbackQuality / 100), wide);
  const deltaQ = rawOut[0] / 128;
  const quality = Math.max(8, Math.min(98.8, Math.round((anchorQ + deltaQ) * 100) / 100));
  const slope = Math.max(0.30, Math.min(1.90, Math.round((0.75 + rawOut[1] / 128) * 1000) / 1000));
  const e0 = rawOut[2], e1 = rawOut[3], e2 = rawOut[4];
  const epfScale = e0 > e1 && e0 >= e2 && e0 > 8 ? 0.74 : e2 > e1 && e2 > e0 && e2 > 8 ? 1.24 : 1.0;

  const rawLayout = [];
  const f0 = n8 > 0 ? rawOut[7] : 0;
  let uniformField = true, allUnitDz = true, nonDefaultSharp = 0;

  for (let i = 0; i < n8; i++) {
    const off = 6 + i * 6, tid = rawOut[off];
    if (tid >= 0) rawLayout.push({id: tid, bx: i % bw, by: (i / bw) | 0});
    if (rawOut[off + 1] !== f0) uniformField = false;
    if (Math.abs(rawOut[off + 2]) >= 23) allUnitDz = false;
    if (cl(rawOut[off + 3], 0, 7) !== 7) nonDefaultSharp++;
  }

  const layout = pruneRareTransforms(splitAtEdges(rawLayout, rawOut, bw, bh));
  let sharpness = null;
  if (nonDefaultSharp >= 6 && quality <= 90) {
    sharpness = new Int16Array(n8);
    for (let i = 0; i < n8; i++) sharpness[i] = cl(rawOut[6 + i * 6 + 3], 0, 7);
  }

  let outField = null, outDz = null;
  if (!uniformField || !allUnitDz) {
    const fieldLog = new Int32Array(n8);
    const dzRaw = new Float64Array(n8);
    let logSum = 0;
    for (let i = 0; i < n8; i++) {
      const off = 6 + i * 6;
      fieldLog[i] = cl(rawOut[off + 1], -190, 256);
      logSum += fieldLog[i];
      dzRaw[i] = Math.max(0.72, Math.min(1.44, 1.0 + rawOut[off + 2] / 256));
    }
    const meanLog = Math.round(logSum / Math.max(1, n8)), p2 = pow2Table();
    const fieldScale = new Float64Array(n8).fill(1.0);
    const dzMap = new Float64Array(n8).fill(1.0);
    let nonUnitField = 0, nonUnitDz = 0;
    for (const b of layout) {
      const t = TRANSFORMS[b.id], tw = Math.max(1, t.width >> 3), th = Math.max(1, t.height >> 3);
      let fAcc = 0, dzAcc = 0, cnt = 0;
      for (let dy = 0; dy < th && b.by + dy < bh; dy++) {
        for (let dx = 0; dx < tw && b.bx + dx < bw; dx++) {
          const c = (b.by + dy) * bw + b.bx + dx;
          fAcc += pow2of256(p2, fieldLog[c] - meanLog);
          dzAcc += dzRaw[c];
          cnt++;
        }
      }
      const fMean = fAcc / Math.max(1, cnt), dzMean = dzAcc / Math.max(1, cnt);
      let fSnap = 1.0;
      if (fineQuant) {
        fSnap = Math.max(0.60, Math.min(2.00, Math.round(fMean * 50) / 50));
        if (Math.abs(fSnap - 1.0) < 0.03) fSnap = 1.0;
      } else {
        let bestF = Infinity;
        for (const lv of AQ_LEVELS_11) { const d = Math.abs(fMean - lv); if (d < bestF) { bestF = d; fSnap = lv; } }
      }
      let dzSnap = 1.0;
      if (fineQuant) {
        dzSnap = Math.max(0.72, Math.min(1.44, Math.round(dzMean * 50) / 50));
        if (Math.abs(dzSnap - 1.0) < 0.03) dzSnap = 1.0;
      } else {
        let bestD = Infinity;
        for (const lv of DZ_SCALES_5) { const d = Math.abs(dzMean - lv); if (d < bestD) { bestD = d; dzSnap = lv; } }
      }
      if (fSnap !== 1.0) nonUnitField += cnt;
      if (dzSnap !== 1.0) nonUnitDz += cnt;
      for (let dy = 0; dy < th && b.by + dy < bh; dy++) {
        for (let dx = 0; dx < tw && b.bx + dx < bw; dx++) {
          const c = (b.by + dy) * bw + b.bx + dx;
          fieldScale[c] = fSnap;
          dzMap[c] = dzSnap;
        }
      }
    }
    if (nonUnitField >= 4) outField = fieldScale;
    if (nonUnitDz >= 2) outDz = dzMap;
  }

  return {quality, slope, epfScale, layout, fieldScale: outField, deadzoneMap: outDz, sharpness};
}

export function decodeVisualLexerPlan(rawOut, width, height, readingIntent, wide, fallbackQuality, fineQuant = false, decoupledDeltaQ = false) {
  const plan = decodeVisualLexerRecipe(rawOut, width, height, readingIntent, wide, fallbackQuality, fineQuant);
  const n8 = Math.ceil(width / 8) * Math.ceil(height / 8), flatness = new Int32Array(n8);
  for (let i = 0; i < n8; i++) flatness[i] = rawOut[6 + i * 6 + 4];
  const effIntent = readingIntent ?? (fallbackQuality / 100);
  return {
    quality: plan.quality,
    slope: plan.slope,
    epfScale: plan.epfScale,
    cflScale: Math.abs(rawOut[5]) >= 6 ? Math.max(0.75, Math.min(1.25, Math.round((1.0 + rawOut[5] / 256) * 100) / 100)) : 1.0,
    layout: plan.layout,
    fieldScale: plan.fieldScale,
    deadzoneMap: plan.deadzoneMap,
    sharpness: plan.sharpness,
    compactDct8: effIntent <= 0.90 || fallbackQuality <= 88,
    tableBands: 6,
    dct8Bands: 8,
    gentleChromaDz: effIntent > 0.84 || fallbackQuality > 85,
    flatness,
    confidence: readVisualLexerConfidence(rawOut, n8, decoupledDeltaQ),
  };
}
