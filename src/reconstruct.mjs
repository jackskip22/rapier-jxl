// SPDX-License-Identifier: MIT
import {exactCbrt, exactCos, exactPow, EXACT_PI} from './exact-math.mjs';
import {scaledDCT, TRANSFORMS} from './vardct-strategies.mjs';
import {float16Bits} from './bits.mjs';

const rcCube = v => v * v * v;
const RC_ONE = [1 - 0.05465007330715401, 1 - 0.07005449891748593, 1 - 0.049935103337343655];
const rcRecon = (q, c) => q === 0 ? 0 : q === 1 ? RC_ONE[c] : q === -1 ? -RC_ONE[c] : q - 0.145 / q;
const RC_BIAS = 0.0037930732552754493, RC_ROOT_BIAS = exactCbrt(RC_BIAS);
const RC_GAB = [0.115169525, 0.061248592];

export function half(value) {
  const bits = float16Bits(value), sign = bits & 0x8000 ? -1 : 1, e = (bits >> 10) & 31, m = bits & 1023;
  return sign * (e ? (1 + m / 1024) * exactPow(2, e - 15) : m / 1024 * exactPow(2, -14));
}

const RC_M = [0.3, 0.622, 0.078, 0.23, 0.692, 0.078, 0.24342268924547819, 0.20476744424496821, 0.5518098665095536];
const RC_INV = (() => {
  const [a, b, c, d, e, f, g, h, i] = RC_M, det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det, (f * g - d * i) / det, (a * i - c * g) / det,
    (c * d - a * f) / det, (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det];
})();

const RC_COS = (n, d) => exactCos(EXACT_PI * n / d);
const RC_LLF_DIVISORS = new Map();
function rcLlfDivisors(w, h) {
  let d = RC_LLF_DIVISORS.get(w * 64 + h);
  if (!d) {
    const scale = (k, size) => RC_COS(k, 2 * size) * RC_COS(k, size) * RC_COS(2 * k, size);
    d = new Float64Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = scale(x, w * 8) * scale(y, h * 8);
    RC_LLF_DIVISORS.set(w * 64 + h, d);
  }
  return d;
}
const RC_LLF_ONE = rcLlfDivisors(1, 1)[0];
export function rcLlfFromDC(means, bw, bh) {
  const w = Math.max(bw, bh), h = Math.min(bw, bh), low = scaledDCT(means, bw, bh), divisors = rcLlfDivisors(w, h);
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = low[y * w + x] / divisors[y * w + x];
  return out;
}

export function inverseBasis(n) {
  return Float64Array.from({length: n * n}, (_, i) => { const k = Math.floor(i / n), x = i % n; return (k ? 1.4142135623730951 : 1) * RC_COS((2 * x + 1) * k, 2 * n); });
}

export function coefficientPlanes(image) {
  const comps = image.components, stride = comps[0].stride, rows = comps[0].rows, W = stride * 8, H = rows * 8;
  const QS = image.quantScale || 256, planes = [0, 1, 2].map(() => new Float32Array(W * H)), cells = new Uint32Array(stride * rows);
  const cfl = image.cfl, base = image.quantFieldBase || 1, fields = image.quantFields;
  const fine = (bx, by) => fields ? fields[by * stride + bx] / base : 1;
  const factors = (bx, by) => { const t = (by >> 3) * cfl.width + (bx >> 3); return [cfl.x[t] / 84, 0, 1 + cfl.b[t] / 84]; };
  const dcStep = comps.map(c => half(c.quant[0] / (255 * 8 * QS) * 128) / 128 * 255 * 8);
  const strategy = image.strategyData;
  if (!strategy) {
    const y = new Float64Array(64), coef = new Float64Array(64), order = [1, 0, 2];
    const quants = comps.map(c => c.quant), coeffs = comps.map(c => c.coeffs), one = [RC_ONE[0], RC_ONE[1], RC_ONE[2]];
    for (let by = 0; by < rows; by++) for (let bx = 0; bx < stride; bx++) {
      const at = (by * stride + bx) * 64, QSf = QS * (fields ? fields[by * stride + bx] / base : 1);
      const t = (by >> 3) * cfl.width + (bx >> 3), kx = cfl.x[t] / 84, kb = 1 + cfl.b[t] / 84;
      cells[by * stride + bx] = bx | by << 12;
      for (let o = 0; o < 3; o++) {
        const c = order[o], q = coeffs[c], quant = quants[c], r1 = one[c];
        coef[0] = q[at] * dcStep[c];
        for (let k = 1; k < 64; k++) {
          const v = q[at + k];
          coef[k] = v === 0 ? 0 : (v === 1 ? r1 : v === -1 ? -r1 : v - 0.145 / v) * quant[k] / QSf;
        }
        if (c === 1) y.set(coef);
        else {
          const k3 = c === 0 ? kx : kb;
          coef[0] += (c === 2 ? 1 : 0) * y[0];
          for (let k = 1; k < 64; k++) coef[k] += k3 * y[k];
        }
        const p = planes[c];
        for (let v = 0, row = by * 8 * W + bx * 8; v < 8; v++, row += W) for (let u = 0; u < 8; u++) p[row + u] = coef[v * 8 + u] / (8 * 255);
      }
    }
    return {planes, cells, W, H, stride, rows};
  }
  const tr = new Float64Array(256 * 256), lumaAC = new Float64Array(256 * 256), channels = [1, 0, 2], one = [RC_ONE[0], RC_ONE[1], RC_ONE[2]];
  const tableSteps = new Map();
  for (const block of strategy.blocks) {
    const {id, bx, by, bw, bh, area, size, order} = block, t = TRANSFORMS[id], w = t.width, h = t.height;
    let steps = tableSteps.get(t.table);
    if (!steps) tableSteps.set(t.table, steps = strategy.tables.get(t.table).planes);
    const f = fields ? fields[by * stride + bx] / base : 1, ct = (by >> 3) * cfl.width + (bx >> 3), k3 = [cfl.x[ct] / 84, 0, 1 + cfl.b[ct] / 84];
    const L = Math.max(bw, bh), S = Math.min(bw, bh), divisor = 8 * QS * f;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) cells[(by + y) * stride + bx + x] = bx | by << 12 | (bw - 1) << 24 | (bh - 1) << 28;
    for (let o = 0; o < 3; o++) {
      const c = channels[o], q = block.coeffs[c], s = steps[c], r1 = one[c];
      tr.fill(0, 0, size);
      for (let k = area; k < size; k++) {
        const pos = order[k], v = q[pos];
        if (v !== 0) tr[pos] = (v === 1 ? r1 : v === -1 ? -r1 : v - 0.145 / v) * s[pos] / divisor;
      }
      if (c === 1) lumaAC.set(tr.subarray(0, size));
      else { const k = k3[c]; for (let i = area; i < size; i++) { const pos = order[i]; tr[pos] += k * lumaAC[pos]; } }
      if (bw === 1 && bh === 1) {
        const pos = by * stride + bx;
        tr[0] = ((comps[c].dc[pos] * dcStep[c] + (c === 2 ? comps[1].dc[pos] * dcStep[1] : 0)) / 8 + 0) / RC_LLF_ONE;
        const p = planes[c];
        for (let v = 0, row = by * 8 * W + bx * 8; v < 8; v++, row += W) for (let u = 0; u < 8; u++) p[row + u] = tr[u * 8 + v] / 255;
        continue;
      }
      const means = new Float64Array(bw * bh);
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        const pos = (by + y) * stride + bx + x;
        means[y * bw + x] = (comps[c].dc[pos] * dcStep[c] + (c === 2 ? comps[1].dc[pos] * dcStep[1] : 0)) / 8;
      }
      const llf = rcLlfFromDC(means, bw, bh);
      for (let y = 0; y < S; y++) for (let x = 0; x < L; x++) tr[y * L * 8 + x] = llf[y * L + x];
      const p = planes[c];
      for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) p[(by * 8 + v) * W + bx * 8 + u] = tr[h >= w ? u * h + v : v * w + u] / 255;
    }
  }
  return {planes, cells, W, H, stride, rows};
}

function rcXybPlanes(image) {
  const {planes: coef, cells, W, H, stride} = coefficientPlanes(image), bases = new Map();
  const ib = n => { let b = bases.get(n); if (!b) bases.set(n, b = inverseBasis(n)); return b; };
  return {W, H, planes: coef.map((C, c) => {
    const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const cell = cells[(y >> 3) * stride + (x >> 3)], x0 = (cell & 4095) * 8, w = ((cell >>> 24 & 15) + 1) * 8, B = ib(w), lx = x - x0;
      let s = 0;
      for (let u = 0; u < w; u++) s += C[y * W + x0 + u] * B[u * w + lx];
      tmp[y * W + x] = s;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const cell = cells[(y >> 3) * stride + (x >> 3)], y0 = (cell >>> 12 & 4095) * 8, h = ((cell >>> 28) + 1) * 8, B = ib(h), ly = y - y0;
      let s = 0;
      for (let v = 0; v < h; v++) s += tmp[(y0 + v) * W + x] * B[v * h + ly];
      out[y * W + x] = s;
    }
    coef[c] = null;
    return out;
  })};
}

function rcGaborish(planes, W, width, height, weights) {
  return planes.map((p, c) => {
    const [w1, w2] = weights === true ? RC_GAB : weights[c], n = 1 / (1 + 4 * w1 + 4 * w2), out = new Float32Array(p.length);
    for (let y = 0; y < height; y++) {
      const u = Math.max(0, y - 1) * W, m = y * W, d = Math.min(height - 1, y + 1) * W;
      for (let x = 0; x < width; x++) {
        const l = Math.max(0, x - 1), r = Math.min(width - 1, x + 1);
        out[m + x] = (p[m + x] + w1 * (p[u + x] + p[d + x] + p[m + l] + p[m + r]) + w2 * (p[u + l] + p[u + r] + p[d + l] + p[d + r])) * n;
      }
    }
    planes[c] = null;
    return out;
  });
}

const RC_INV_SIGMA_NUM = -1.1715728752538099024, RC_MIN_SIGMA = -3.90524291751269967465540850526868, RC_SCALE = [40, 5, 3.5];
function rcEpf1(planes, W, width, height, invSigma, stride, borderMul) {
  const mir = (v, n) => v < 0 ? -v - 1 : v >= n ? 2 * n - v - 1 : v;
  const rows = Number.isSafeInteger(width) && width > 0 && width <= W &&
    Number.isSafeInteger(height) && height > 0 && height * W <= planes[0].length;
  const out = planes.map(p => rows ? new Float32Array(3 * width) : Float32Array.from(p));
  const commit = y => {
    const row = (y % 3) * width;
    for (let c = 0; c < 3; c++) planes[c].set(out[c].subarray(row, row + width), y * W);
  };
  const at = (c, x, y) => planes[c][mir(y, height) * W + mir(x, width)];
  const plus = [[0, 0], [0, -1], [-1, 0], [1, 0], [0, 1]], nb = [[0, -1], [-1, 0], [1, 0], [0, 1]];
  const offsets = [0, -W, -1, 1, W], neighbors = [-W, -1, 1, W];
  const above = new Float64Array(width), haveAbove = new Uint8Array(width);
  const sm = 1.65, bsm = sm * borderMul;
  for (let y = 0; y < height; y++) {
    const row = rows ? (y % 3) * width : y * W;
    if (rows) for (let c = 0; c < 3; c++) out[c].set(planes[c].subarray(y * W, y * W + width), row);
    const rowBorder = (y & 7) === 0 || (y & 7) === 7;
    let left = 0, haveLeft = false;
    for (let x = 0; x < width; x++) {
      const s = invSigma[(y >> 3) * stride + (x >> 3)];
      if (s < RC_MIN_SIGMA) { haveLeft = false; haveAbove[x] = 0; continue; }
      const mul = rowBorder || (x & 7) === 0 || (x & 7) === 7 ? bsm : sm, inv = s * mul;
      let w = 1, X, Y, B;
      if (x >= 2 && y >= 2 && x < width - 2 && y < height - 2) {
        const i = y * W + x, P0 = planes[0], P1 = planes[1], P2 = planes[2];
        X = P0[i]; Y = P1[i]; B = P2[i];
        for (let n = 0; n < 4; n++) {
          const j = i + neighbors[n];
          let sad;
          if (n === 0 && haveAbove[x]) sad = above[x];
          else if (n === 1 && haveLeft) sad = left;
          else {
            let s0 = 0, s1 = 0, s2 = 0;
            for (let o = 0; o < 5; o++) {
              const a = i + offsets[o], b = j + offsets[o];
              s0 += Math.abs(P0[a] - P0[b]); s1 += Math.abs(P1[a] - P1[b]); s2 += Math.abs(P2[a] - P2[b]);
            }
            sad = s0 * 40 + s1 * 5 + s2 * 3.5;
          }
          if (n === 2) left = sad;
          else if (n === 3) above[x] = sad;
          const weight = Math.max(0, 1 + sad * inv);
          w += weight; X += weight * P0[j]; Y += weight * P1[j]; B += weight * P2[j];
        }
      } else {
        X = at(0, x, y); Y = at(1, x, y); B = at(2, x, y);
        for (let n = 0; n < 4; n++) {
          const [dx, dy] = nb[n];
          let sad;
          if (n === 0 && haveAbove[x]) sad = above[x];
          else if (n === 1 && haveLeft) sad = left;
          else {
            sad = 0;
            for (let c = 0; c < 3; c++) {
              let sc = 0;
              for (const [ox, oy] of plus) sc += Math.abs(at(c, x + ox, y + oy) - at(c, x + dx + ox, y + dy + oy));
              sad += sc * RC_SCALE[c];
            }
          }
          if (n === 2) left = sad;
          else if (n === 3) above[x] = sad;
          const weight = Math.max(0, 1 + sad * inv);
          w += weight; X += weight * at(0, x + dx, y + dy); Y += weight * at(1, x + dx, y + dy); B += weight * at(2, x + dx, y + dy);
        }
      }
      haveLeft = true; haveAbove[x] = 1;
      out[0][row + x] = X / w; out[1][row + x] = Y / w; out[2][row + x] = B / w;
    }
    if (rows && y >= 2) commit(y - 2);
  }
  if (rows) for (let y = Math.max(0, height - 2); y < height; y++) commit(y);
  return rows ? planes : out;
}

export function epfInverseSigma(image) {
  const stride = image.components[0].stride, rows = image.components[0].rows, field = image.quantFieldBase || 1;
  let shift = 1;
  while (field * shift / (8 * 255 * (image.quantScale || 1)) < 1 / 16384) shift *= 2;
  const mul = half(image.epf), inv = new Float32Array(stride * rows);
  const firstOf = image.strategyData ? new Int32Array(stride * rows) : null;
  if (firstOf) for (const b of image.strategyData.blocks) for (let y = 0; y < b.bh; y++) for (let x = 0; x < b.bw; x++) firstOf[(b.by + y) * stride + b.bx + x] = b.by * stride + b.bx;
  for (let b = 0; b < inv.length; b++) {
    const first = firstOf ? firstOf[b] : b, raw = (image.quantFields ? image.quantFields[first] : field) * shift;
    inv[b] = 1 / Math.min(-1e-4, mul / (raw * RC_INV_SIGMA_NUM) * (image.sharpness ? image.sharpness[b] : 7) / 7);
  }
  return inv;
}

export function reconstruct(image) {
  const {width, height} = image, comps = image.components, stride = comps[0].stride, rows = comps[0].rows;
  let {planes, W, H} = rcXybPlanes(image);
  if (image.gab) planes = rcGaborish(planes, W, width, height, image.gab);
  if (image.epf) planes = rcEpf1(planes, W, width, height, epfInverseSigma(image), stride, 2 / 3);
  const n = width * height, compact = Number.isSafeInteger(width) && width > 0 && width <= W &&
    Number.isSafeInteger(height) && height > 0 && height <= H;
  const out = compact ? planes : [0, 1, 2].map(() => new Float32Array(n));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * W + x, X = planes[0][i], Y = planes[1][i], B = planes[2][i];
    const l = rcCube(Y + X + RC_ROOT_BIAS) - RC_BIAS, m = rcCube(Y - X + RC_ROOT_BIAS) - RC_BIAS, s = rcCube(B + RC_ROOT_BIAS) - RC_BIAS, o = y * width + x;
    out[0][o] = RC_INV[0] * l + RC_INV[1] * m + RC_INV[2] * s;
    out[1][o] = RC_INV[3] * l + RC_INV[4] * m + RC_INV[5] * s;
    out[2][o] = RC_INV[6] * l + RC_INV[7] * m + RC_INV[8] * s;
  }
  if (!compact || planes.every(p => p.length === n)) return out;
  return planes.map((p, c) => {
    const result = p.slice(0, n);
    planes[c] = null;
    return result;
  });
}

export function toRGBA(linear, width, height) {
  const out = new Uint8ClampedArray(width * height * 4), enc = v => v <= 0.0031308 ? 12.92 * v : 1.055 * exactPow(v, 1 / 2.4) - 0.055;
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(255 * Math.min(1, Math.max(0, enc(linear[c][i]))));
    out[i * 4 + 3] = 255;
  }
  return out;
}
