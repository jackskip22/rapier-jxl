// SPDX-License-Identifier: MIT
import {BitWriter, float16Bits, ceilLog2, packSigned} from './bits.mjs';
import {admitOutputSize} from './admit.mjs';
import {writeHeaderFields, writeFrameHeaderEnd, finishSections, assembleCodestream, GROUP_DIM} from './frame.mjs';
import {ZERO_PREDICTOR, GRADIENT_PREDICTOR, leaf} from './modular.mjs';
import {writeModularStream, writeSmallerModularStream, writeLocalModularStream} from './modular-channel.mjs';
import {writeContextMap} from './prefix.mjs';
import {NONZERO_BUCKETS, ZERO_DENSITY_CONTEXTS, ORDERS, SCAN, DCT8_DENSITY} from './dct8-contexts.mjs';
import {buildCaptureTokenCoding} from './capture-prefix.mjs';
import {photoKernels} from './capture-kernels.mjs';
import {writeCapturePatches} from './capture-patches.mjs';

const FAST_MAP = Uint8Array.from({length: 3 * ORDERS}, (_, i) => (i / ORDERS) | 0);
const FAST_HEADER_RGB = (() => {
  const w = new BitWriter(64);
  w.write(4, 0); w.write(4, 0); w.write(4, 0);
  writeContextMap(w, FAST_MAP);
  return w;
})();

function blockFields(fields, stride, x0, y0, rw, rh) {
  const count = rw * rh, data = new Int32Array(2 * count);
  for (let y = 0, i = count; y < rh; y++) for (let x = 0; x < rw; x++, i++) data[i] = fields[(y0 + y) * stride + x0 + x] - 1;
  return data;
}

export function writeCaptureVarDCT(jpeg, {
  isFirstFrame = true, isLastFrame = true, crop = null, saveAsReference = 0,
  alphaChannel = Boolean(jpeg.alpha), imageWidth, imageHeight, mask = false, ans = null, patches = null,
} = {}) {
  const {tokenGroup: captureTokenGroup, plane: capturePlane, tokens: tokenKernels} = photoKernels();
  if (mask && (!alphaChannel || !crop)) throw new Error('A mask needs alpha and a crop.');
  const {width, height, components, alpha, xyb} = jpeg;
  const epf = xyb ? jpeg.epf || 0 : 0, quantScale = jpeg.quantScale || 1;
  let field = jpeg.quantFieldBase || 1;
  while (field / (8 * 255 * quantScale) < 1 / 16384) field *= 2;
  let modular16bit = field <= 32768;
  const ycbcr = !xyb && Boolean(jpeg.ycbcr);
  const map = ycbcr ? [1, 0, 2] : [0, 1, 2];
  const comps = map.map(i => components[i]);
  const xsizeBlocks = Math.ceil(width / 8), ysizeBlocks = Math.ceil(height / 8);
  const groupsX = Math.ceil(width / GROUP_DIM), groupsY = Math.ceil(height / GROUP_DIM), numGroups = groupsX * groupsY;
  const dcGroupsX = Math.ceil(xsizeBlocks / 256), dcGroupsY = Math.ceil(ysizeBlocks / 256), numDcGroups = dcGroupsX * dcGroupsY;
  const single = numGroups === 1;

  const tokens = g => captureTokenGroup(comps, width, height, g, DCT8_DENSITY, SCAN);
  const groups = function* () { for (let g = 0; g < numGroups; g++) yield tokens(g); };
  const prefix = buildCaptureTokenCoding(3 * (NONZERO_BUCKETS + ZERO_DENSITY_CONTEXTS), groups(), tokenKernels?.(), ...clustering(ans));
  const coding = ans && ans(prefix, groups()) || prefix;

  const writers = Array.from({length: single ? 1 : 2 + numDcGroups + numGroups}, () => null);
  const section = index => writers[single ? 0 : index] || (writers[single ? 0 : index] = new BitWriter(4096));
  const sectionSizes = new Uint32Array(writers.length);
  let sectionBytes = 0;
  const checkSection = index => {
    index = single ? 0 : index;
    const size = Math.ceil(writers[index].bitLength / 8);
    sectionBytes += size - sectionSizes[index]; sectionSizes[index] = size;
    admitOutputSize(sectionBytes);
  };

  const dc = section(0);
  if (patches) writeCapturePatches(dc, patches, false);
  dc.write(1, 0);
  const alphaPlane = (gx, gy) => {
    const x0 = gx * GROUP_DIM, y0 = gy * GROUP_DIM, w = Math.min(GROUP_DIM, width - x0), h = Math.min(GROUP_DIM, height - y0);
    const data = alpha ? capturePlane(alpha, width, x0, y0, w, h, 4, 3) : new Int16Array(w * h).fill(mask ? 1 : 255);
    if (mask && alpha) for (let i = 0; i < data.length; i++) data[i] >>= 7;
    return {w, h, data};
  };
  for (let c = 0; c < 3; c++) dc.write(16, float16Bits(comps[c].quant[0] / (255 * 8 * quantScale) * 128));
  dc.write(2, 3); dc.write(16, 65536 - 8193);
  dc.write(2, 1); dc.write(5, 0);
  dc.write(1, 0); dc.write(4, 0);
  dc.append(FAST_HEADER_RGB);
  if (xyb) dc.write(1, 1);
  else { const base = jpeg.cflBase ? 0x3c00 : 0; dc.write(1, 0); dc.write(2, 0); dc.write(16, base); dc.write(16, base); dc.write(8, 128); dc.write(8, 128); }
  dc.write(1, 0);
  if (alphaChannel) writeModularStream(dc, [numGroups === 1 ? alphaPlane(0, 0) : {w: 0, h: 0, data: new Int32Array(0)}], GRADIENT_PREDICTOR, mask ? 255 : 1);
  checkSection(0);

  for (let g = 0; g < numDcGroups; g++) {
    const w = section(1 + g), gx = g % dcGroupsX, gy = (g / dcGroupsX) | 0;
    const x0 = gx * 256, y0 = gy * 256, rw = Math.min(256, xsizeBlocks - x0), rh = Math.min(256, ysizeBlocks - y0);
    w.write(2, 0);
    const planes = [1, 0, 2].map(c => ({w: rw, h: rh,
      data: capturePlane(comps[c].coeffs, comps[c].stride, x0, y0, rw, rh, 64)}));
    writeDCPlanes(w, planes, ans);
    const count = rw * rh, bits = ceilLog2(count);
    if (bits) w.write(bits, count - 1);
    const cw = (rw + 7) >> 3, ch = (rh + 7) >> 3;
    const colors = jpeg.cfl
      ? [jpeg.cfl.x, jpeg.cfl.b].map(data => capturePlane(data, jpeg.cfl.width, x0 >> 3, y0 >> 3, cw, ch))
      : [new Int16Array(cw * ch), new Int16Array(cw * ch)];
    const metadata = [
      {w: cw, h: ch, data: colors[0]}, {w: cw, h: ch, data: colors[1]},
      jpeg.quantFields ? {w: count, h: 2, data: blockFields(jpeg.quantFields, xsizeBlocks, x0, y0, rw, rh)} : {w: count, h: 2, rowValues: [0, field - 1]},
      {w: rw, h: rh, rowValues: new Int16Array(rh).fill(epf ? 7 : 0)},
    ];
    writeSmallerModularStream(w, metadata, field > 1 ? GRADIENT_PREDICTOR : ZERO_PREDICTOR);
    checkSection(1 + g);
  }

  const ac = section(1 + numDcGroups);
  ac.write(1, 0);
  for (let i = 0; i < 17; i++) {
    if (i !== 0) { ac.write(3, 0); continue; }
    if (jpeg.quantTable) { ac.write(3, 6); ac.write(4, 5); for (const c of map) for (const bits of jpeg.quantTable[c]) ac.write(16, bits); continue; }
    ac.write(3, 7); ac.write(16, float16Bits(field / (8 * 255 * quantScale)));
    const qPlanes = comps.map(({quant}) => ({w: 8, h: 8, data: Int32Array.from({length: 64}, (_, i) => quant[(i & 7) * 8 + (i >> 3)])}));
    writeSmallerModularStream(ac, qPlanes, GRADIENT_PREDICTOR);
    if (qPlanes.some(p => p.data.some(v => v < -32768 || v > 32767))) modular16bit = false;
  }
  if (numGroups > 1) ac.write(ceilLog2(numGroups), 0);
  ac.write(2, 2);
  coding.writeHistograms(ac);
  checkSection(1 + numDcGroups);

  for (let g = 0; g < numGroups; g++) {
    const w = section(2 + numDcGroups + g);
    const {ctxs, values, n} = tokens(g);
    coding.writeTokens(w, ctxs, values, n);
    if (alphaChannel && numGroups > 1) writeModularStream(w, [alphaPlane(g % groupsX, (g / groupsX) | 0)], GRADIENT_PREDICTOR, mask ? 255 : 1);
    checkSection(2 + numDcGroups + g);
  }

  const header = new BitWriter(256);
  if (isFirstFrame) writeHeaderFields(header, imageWidth ?? jpeg.width, imageHeight ?? jpeg.height, 3, alphaChannel, {xyb, colorSpace: jpeg.colorSpace || 'srgb', modular16bit});
  header.write(1, 0); header.write(2, 0); header.write(1, 0);
  header.write(2, 2); header.write(8, (patches ? 130 : 128) - 17);
  if (!xyb) header.write(1, ycbcr ? 1 : 0);
  if (ycbcr) header.write(6, 0);
  header.write(2, 0);
  if (alphaChannel) header.write(2, 0);
  if (xyb) { header.write(3, 2); header.write(3, 2); }
  writeFrameHeaderEnd(header, alphaChannel, epf, null, 1, null, {crop, canvas: imageWidth && {width: imageWidth, height: imageHeight}, last: isLastFrame, reference: saveAsReference, mask});
  return assembleCodestream(header, finishSections(writers));
}


export const clustering = ans => ans ? [60, 128] : [240, 32];

export function writeDCPlanes(w, planes, ans) {
  if (!ans) return writeModularStream(w, planes, GRADIENT_PREDICTOR);
  let best = null;
  for (let predictor = 0; predictor <= 6; predictor++) {
    const candidate = new BitWriter(256);
    if (predictor === 6) writeLocalModularStream(candidate, planes); else writeModularStream(candidate, planes, predictor);
    if (!best || candidate.bitLength < best.bitLength) best = candidate;
  }
  w.append(best);
}

export const AC_BUCKETS = 4;
export function acBlockLevels(data, width, height) {
  const bw = width >> 3, bh = height >> 3, counts = new Uint32Array(256);
  if (!bw || !bh) return null;
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let sum = 0;
    for (let y = 0; y < 8; y++) for (let x = 0, at = ((by * 8 + y) * width + bx * 8) * 4 + 1; x < 8; x++, at += 4) sum += data[at];
    counts[sum >> 6]++;
  }
  const levels = [], total = bw * bh;
  for (let v = 0, seen = 0; v < 256 && levels.length < AC_BUCKETS - 1; v++) {
    seen += counts[v];
    while (levels.length < AC_BUCKETS - 1 && seen > total * (levels.length + 1) / AC_BUCKETS) levels.push(v);
  }
  while (levels.length < AC_BUCKETS - 1) levels.push(255);
  return levels;
}
export function acBlockContexts(levels) {
  const K = levels ? AC_BUCKETS : 1, blockOf = (c, b) => c === 1 ? b : K + (c === 0 ? 0 : 1);
  const table = Int32Array.from({length: 3 * K}, (_, i) => blockOf((i / K) | 0, i % K));
  const map = Uint8Array.from({length: 3 * ORDERS * K}, (_, i) => { const row = (i / (ORDERS * K)) | 0; return blockOf(row === 0 ? 1 : row === 1 ? 0 : 2, i % K); });
  let thresholds = levels ? null : new Int32Array(0);
  return {K, table, map, numCtxs: K + 2, contexts: (K + 2) * (NONZERO_BUCKETS + ZERO_DENSITY_CONTEXTS),
    get thresholds() { return thresholds; },
    fix(step, quantScale) { thresholds ??= Int32Array.from(levels, v => Math.round((v + 0.5) * 8 * quantScale / step)); return this; },
    bucket(dc) { let b = 0; while (b < thresholds.length && dc > thresholds[b]) b++; return b; }};
}
export function writeAcBlockContexts(w, ac) {
  w.write(1, 0); w.write(4, 0);
  w.write(4, ac.thresholds.length);
  for (const t of ac.thresholds) w.writeU32([[4, 0], [8, 16], [16, 272], [32, 65808]], packSigned(t));
  w.write(4, 0); w.write(4, 0);
  writeContextMap(w, ac.map);
}
