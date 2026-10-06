// Rapier's JPEG XL encoder: a JPEG carried into a VarDCT frame. MIT (LICENSE).
// The JPEG's quantised DCT coefficients become the frame's coefficients without loss, the way libjxl transcodes
// a JPEG: its quantisation tables as raw dequantisation matrices, its DC values as the DC image, its colour
// (YCbCr, or RGB) and chroma subsampling kept, every block an 8x8 DCT, no filters, no smoothing, no chroma from
// luma. Only the entropy coding changes: JPEG XL's contexts over the coefficients, with prefix codes.
import {BitWriter, float16Bits, packSigned, ceilLog2, complete} from './bits.mjs';
import {writeImageHeader, writeFrameHeaderEnd, finishSections, assembleCodestream, GROUP_DIM} from './frame.mjs';
import {ZERO_PREDICTOR, GRADIENT_PREDICTOR, ALPHABET, leaf, channelTree, writeTree, writeModularHeader, writeChannelHistograms, codeChannel} from './modular.mjs';
import {writeContextMap, writeHistograms, buildCode, uintConfig, countToken, writeHybrid} from './prefix.mjs';
import {TokenCounts, buildTokenCoding} from './entropy.mjs';
import {parseJPEG, jpegError, ZIGZAG} from './jfif.mjs';
import {admitOutputSize} from './admit.mjs';

const NONZERO_BUCKETS = 37, ZERO_DENSITY_CONTEXTS = 458, ORDERS = 13;
const COEFF_FREQ_CONTEXT = [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 15, 16, 16, 17, 17, 18, 18, 19, 19, 20, 20, 21, 21, 22, 22,
  23, 23, 23, 23, 24, 24, 24, 24, 25, 25, 25, 25, 26, 26, 26, 26, 27, 27, 27, 27, 28, 28, 28, 28, 29, 29, 29, 29, 30, 30, 30, 30];
const COEFF_NUM_NONZERO_CONTEXT = [0, 0, 31, 62, 62, 93, 93, 93, 93, 123, 123, 123, 123, 152, 152, 152, 152, 152, 152, 152, 152, 180, 180, 180, 180, 180,
  180, 180, 180, 180, 180, 180, 180, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206,
  206, 206, 206, 206, 206, 206, 206, 206];

// The frame's natural coefficient order for an 8x8 block (the zigzag over the frame's transposed layout), each
// entry already turned into the JPEG's natural index of that coefficient.
// This is the JPEG zigzag with each position transposed: frame index u*8 + v holds JPEG coefficient v*8 + u.
const SCAN = ZIGZAG.map(n => ((n & 7) << 3) | (n >> 3));

const zeroDensityContext = (left, k, prev) => (COEFF_NUM_NONZERO_CONTEXT[left] + COEFF_FREQ_CONTEXT[k]) * 2 + prev;

// Block contexts as libjxl chooses them for a JPEG: luma blocks in up to eight buckets of their quantised DC (more
// buckets for larger, finer pictures), chroma in about half as many, one chroma context for a grey picture.
function blockContexts(luma, thresholdsWanted, grey) {
  const thresholds = [];
  if (thresholdsWanted > 0) {
    const counts = new Uint32Array(2048);
    let total = 0;
    for (const value of luma) { counts[Math.min(2047, Math.max(0, value + 1024))]++; total++; }
    let cumulative = 0, cut = total / (thresholdsWanted + 1);
    for (let j = 0; j < 2048 && thresholds.length < thresholdsWanted; j++) {
      cumulative += counts[j];
      if (cumulative > cut) { thresholds.push(j - 1025); cut = total * (thresholds.length + 1) / (thresholdsWanted + 1); }
    }
  }
  const numDc = thresholds.length + 1, map = new Uint8Array(3 * ORDERS * numDc);
  for (let i = 0; i < numDc; i++) for (let ord = 0; ord < ORDERS; ord++) {
    map[(0 * ORDERS + ord) * numDc + i] = i;
    map[(1 * ORDERS + ord) * numDc + i] = grey ? numDc : numDc + (i >> 1);
    map[(2 * ORDERS + ord) * numDc + i] = grey ? numDc : numDc + ((numDc - 1) >> 1) + 1 + (i >> 1);
  }
  let numCtxs = 0;
  for (const v of map) numCtxs = Math.max(numCtxs, v + 1);
  const bucketOf = value => { let b = 0; for (const t of thresholds) if (value > t) b++; return b; };
  return {thresholds, numDc, map, numCtxs, bucketOf,
    contextOf: (c, bucket) => map[((c < 2 ? c ^ 1 : 2) * ORDERS) * numDc + bucket],
    nonZero: (predicted, blockCtx) => (Math.min(predicted, 64) < 8 ? Math.min(predicted, 64) : 4 + (Math.min(predicted, 64) >> 1)) * numCtxs + blockCtx,
    zeroDensityOffset: blockCtx => numCtxs * NONZERO_BUCKETS + ZERO_DENSITY_CONTEXTS * blockCtx,
    contexts: numCtxs * (NONZERO_BUCKETS + ZERO_DENSITY_CONTEXTS)};
}

// A modular stream with its own tree: one leaf per channel, the given predictor, counted then written.
function writeModularStream(w, planes, predictor) {
  const leaves = planes.map(() => leaf(predictor));
  const freqs = leaves.map(() => new Uint32Array(ALPHABET));
  planes.forEach((p, i) => codeChannel(null, freqs[i], p.data, p.w, p.h, leaves[i]));
  writeModularHeader(w, {useGlobalTree: false, transforms: []});
  const ordered = writeTree(w, channelTree(leaves));
  const histograms = writeChannelHistograms(w, ordered, freqs, l => leaves.indexOf(l));
  planes.forEach((p, i) => codeChannel(w, histograms[i + 1].code, p.data, p.w, p.h, leaves[i]));
}

export function transcodeJPEG(bytes, jpeg = parseJPEG(bytes)) { return encodeVarDCT(jpeg); }

// Shared coefficient writer. Pixel encoding supplies the same natural-order DCT8 planes as the JPEG reader;
// quantScale lets its raw integer matrices carry fractional steps without a second entropy/frame writer.
export function encodeVarDCT(jpeg, plan) { return complete(varDCTSteps(jpeg, plan)); }

// The same as steps: a group of each counting pass, a DC group, an AC group per step.
export function* varDCTSteps(jpeg, plan = {}) {
  const {width, height, components, alpha} = jpeg, grey = components.length === 1;
  const quantScale = jpeg.quantScale || 1;
  // The raw tables' denominator, 1 / (8 x 255 x quantScale), is a normal binary16: where it would be subnormal (the
  // photo door's), it is doubled until it is not and every block's quantisation field doubled with it, so the decoder's
  // dequantised coefficients are the same. A decoder that reads a subnormal wrong (jxl-rs 0.7.4 halves them) reads these.
  let field = jpeg.quantFieldBase || 1;
  while (field / (8 * 255 * quantScale) < 1 / 16384) field *= 2;
  const ycbcr = jpeg.ycbcr || grey;
  const map = grey ? [0, 0, 0] : ycbcr ? [1, 0, 2] : [0, 1, 2];  // frame channel (X, Y, B) to JPEG component
  const comps = map.map(i => components[i]);
  const orders = plan.orders ? map.map(i => plan.orders[i].map(k => SCAN[k])) : [SCAN, SCAN, SCAN];
  const log2 = v => v === 1 ? 0 : v === 2 ? 1 : -1;
  const rawH = comps.map(c => log2(c.h)), rawV = comps.map(c => log2(c.v));
  if (rawH.includes(-1) || rawV.includes(-1)) throw jpegError('sampling factors other than one or two');
  const maxhs = Math.max(...rawH), maxvs = Math.max(...rawV);
  const hshift = c => maxhs - rawH[c], vshift = c => maxvs - rawV[c];
  if (!ycbcr && (maxhs || maxvs)) throw jpegError('an RGB JPEG with subsampling');
  const xsizeBlocks = Math.ceil(width / (8 << maxhs)) << maxhs, ysizeBlocks = Math.ceil(height / (8 << maxvs)) << maxvs;
  const groupsX = Math.ceil(width / GROUP_DIM), groupsY = Math.ceil(height / GROUP_DIM), numGroups = groupsX * groupsY;
  const dcGroupsX = Math.ceil(xsizeBlocks / 256), dcGroupsY = Math.ceil(ysizeBlocks / 256), numDcGroups = dcGroupsX * dcGroupsY;
  const single = numGroups === 1;
  // A block's coefficients: the JPEG's block (bx, by) at the channel's scale; chroma of a grey picture is empty.
  const blockAt = (c, bx, by) => { const comp = comps[c]; if (grey && c !== 1) return -1; return ((by * comp.stride) + bx) * 64; };

  // An RGB JPEG's level shift comes back through the DC: 128 in pixel units, 1024 in the coefficient's, as libjxl adds
  // it; a YCbCr frame keeps its DC as it is (the decoder's YCbCr transform centres it). 1024 divided by the DC step
  // is whole only when the step divides 1024, so the frame's DC step is the step's greatest power-of-two divisor of
  // 1024 and the stored DC is the JPEG's times the step over that, plus the shift, whole: the decoder's dequantised DC
  // is exact for every step (a step of 40 used to lift by 25 x 40 = 1000 for 1024, three levels dark on a flat field).
  const gcd1024 = q => { let d = 1024; while (q % d) d >>= 1; return d; };
  const dcScale = comps.map(c => ycbcr ? 1 : c.quant[0] / gcd1024(c.quant[0]));
  const dcLift = comps.map(c => ycbcr ? 0 : 1024 / gcd1024(c.quant[0]));
  // Every luma block's DC as the frame stores it, for the block context buckets.
  const lumaDc = new Int32Array(xsizeBlocks * ysizeBlocks);
  for (let by = 0; by < ysizeBlocks; by++) for (let bx = 0; bx < xsizeBlocks; bx++) lumaDc[by * xsizeBlocks + bx] = comps[1].coeffs[blockAt(1, bx, by)] * dcScale[1] + dcLift[1];
  const lumaQuant = comps[1].quant, quantSum = (lumaQuant[8] + lumaQuant[16] + lumaQuant[24] + lumaQuant[32] + lumaQuant[40]) / quantScale;
  const blocksTotal = xsizeBlocks * ysizeBlocks;
  const wanted = blocksTotal < 256 ? 0 : Math.max(1, Math.min(7, ceilLog2(blocksTotal) - ceilLog2(quantSum) - 7));
  let contexts = blockContexts(lumaDc, wanted, grey);

  const header = new BitWriter(256);
  writeImageHeader(header, width, height, grey ? 1 : 3, !!alpha, {orientation: jpeg.orientation, colorSpace: jpeg.colorSpace});
  // The frame header: VarDCT, adaptive DC smoothing skipped, the colour and subsampling of the JPEG.
  header.write(1, 0); header.write(2, 0); header.write(1, 0);
  header.write(2, 2); header.write(8, 128 - 17);  // flags: kSkipAdaptiveDCSmoothing
  header.write(1, ycbcr ? 1 : 0);
  if (ycbcr) for (let c = 0; c < 3; c++) header.write(2, rawH[c] === 0 && rawV[c] === 0 ? 0 : rawH[c] === 1 && rawV[c] === 1 ? 1 : rawH[c] === 1 ? 2 : 3);
  header.write(2, 0);  // no upsampling
  if (alpha) header.write(2, 0);  // no extra-channel upsampling
  writeFrameHeaderEnd(header, alpha);

  // The AC tokens of every group, counted first and written second.
  const nzeros = [0, 1, 2].map(() => new Int32Array(32 * 32));
  const tokens = (g, emit) => {
    const gx = g % groupsX, gy = (g / groupsX) | 0, bx0 = gx * 32, by0 = gy * 32;
    const bw = Math.min(32, xsizeBlocks - bx0), bh = Math.min(32, ysizeBlocks - by0);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) for (const c of [1, 0, 2]) {
      const hs = hshift(c), vs = vshift(c), sbx = bx >> hs, sby = by >> vs;
      if ((sbx << hs) !== bx || (sby << vs) !== by) continue;
      const at = blockAt(c, (bx0 >> hs) + sbx, (by0 >> vs) + sby), coeffs = comps[c].coeffs;
      let count = 0;
      if (at >= 0) for (let k = 1; k < 64; k++) if (coeffs[at + k]) count++;
      const row = nzeros[c], predicted = sbx === 0 ? (sby === 0 ? 32 : row[(sby - 1) * 32]) : sby === 0 ? row[sby * 32 + sbx - 1] : (row[(sby - 1) * 32 + sbx] + row[sby * 32 + sbx - 1] + 1) >> 1;
      row[sby * 32 + sbx] = count;
      const blockCtx = contexts.contextOf(c, contexts.bucketOf(lumaDc[(by0 + by) * xsizeBlocks + bx0 + bx]));
      emit(contexts.nonZero(predicted, blockCtx), count);
      const offset = contexts.zeroDensityOffset(blockCtx);
      let prev = count > 4 ? 0 : 1, left = count;
      for (let k = 1; k < 64 && left; k++) {
        const coeff = coeffs[at + orders[c][k]];
        emit(offset + zeroDensityContext(left, k, prev), packSigned(coeff));
        prev = coeff ? 1 : 0; left -= prev;
      }
    }
  };
  // Bucketed contexts win on photographs and lose on small or flat pictures: both are counted and the cheaper kept.
  const total = (wanted > 0 ? 3 : 2) * numGroups + numDcGroups;
  let done = 0;
  const countWith = function* (chosen) {
    contexts = chosen;
    const counts = new TokenCounts(chosen.contexts);
    for (let g = 0; g < numGroups; g++) { tokens(g, (ctx, value) => counts.add(ctx, value)); yield ++done / total; }
    return (plan.coding || buildTokenCoding)(counts, plan.clusters);
  };
  let coding = yield* countWith(contexts);
  if (wanted > 0) {
    const bucketed = contexts, plain = blockContexts(lumaDc, 0, grey), plainCoding = yield* countWith(plain);
    if (plainCoding.bits <= coding.bits) coding = plainCoding; else contexts = bucketed;
  }

  const writers = Array.from({length: single ? 1 : 2 + numDcGroups + numGroups}, () => null);
  const section = index => writers[single ? 0 : index] || (writers[single ? 0 : index] = new BitWriter(4096));
  // Refuse as completed sections cross the whole-stream bound, before later groups or section copies allocate.
  // A one-group frame shares its writer, so only its growth since the last checkpoint is charged again.
  const sectionSizes = new Uint32Array(writers.length);
  let sectionBytes = 0;
  const checkSection = index => {
    index = single ? 0 : index;
    const size = Math.ceil(writers[index].bitLength / 8);
    sectionBytes += size - sectionSizes[index]; sectionSizes[index] = size;
    admitOutputSize(sectionBytes);
  };

  // DC global: the DC quantisation of each channel, the quantizer at scale one, luma and chroma block contexts, no
  // chroma from luma, no global modular tree.
  const dc = section(0);
  dc.write(1, 0);

  // VarDCT's extra channels are modular and exact. A small alpha plane lives in DC global; larger ones are
  // independent 256-pixel groups after their AC coefficients. Only one group's temporary plane is allocated.
  const alphaPlane = (gx, gy) => {
    const x0 = gx * GROUP_DIM, y0 = gy * GROUP_DIM, w = Math.min(GROUP_DIM, width - x0), h = Math.min(GROUP_DIM, height - y0), data = new Int32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = alpha[((y0 + y) * width + x0 + x) * 4 + 3];
    return {w, h, data};
  };
  // The DC step of each channel in the frame's units (the JPEG's DC quant, over the scale above, over 8 times 255),
  // stored times 128.
  for (let c = 0; c < 3; c++) dc.write(16, float16Bits(comps[c].quant[0] / dcScale[c] / (255 * 8 * quantScale) * 128));
  dc.write(2, 3); dc.write(16, 65536 - 8193);
  dc.write(2, 1); dc.write(5, 0);
  dc.write(1, 0); dc.write(4, 0);
  dc.write(4, contexts.thresholds.length);
  for (const t of contexts.thresholds) dc.writeU32([[4, 0], [8, 16], [16, 272], [32, 65808]], packSigned(t));
  dc.write(4, 0); dc.write(4, 0);
  writeContextMap(dc, contexts.map);
  // Chroma from luma switched off in full: the default map carries a base luma-to-B ratio of one (meant for XYB),
  // which a 4:4:4 or grey frame would apply to its Cr. Colour factor 84, both bases zero, no DC correlation.
  dc.write(1, 0); dc.write(2, 0); dc.write(16, 0); dc.write(16, 0); dc.write(8, 128); dc.write(8, 128);
  dc.write(1, 0);
  if (alpha) writeModularStream(dc, [single ? alphaPlane(0, 0) : {w: 0, h: 0, data: new Int32Array(0)}], GRADIENT_PREDICTOR);
  checkSection(0);

  // DC groups: the DC coefficients as a modular image (luma first), then the AC metadata: all blocks 8x8 DCT at
  // quant one, no chroma-from-luma tiles, no sharpness.
  for (let g = 0; g < numDcGroups; g++) {
    const w = section(1 + g), gx = g % dcGroupsX, gy = (g / dcGroupsX) | 0;
    const x0 = gx * 256, y0 = gy * 256, rw = Math.min(256, xsizeBlocks - x0), rh = Math.min(256, ysizeBlocks - y0);
    w.write(2, 0);
    // The DC of every block, scaled and lifted as above (an RGB frame), or the JPEG's own (YCbCr).
    const planes = [1, 0, 2].map(c => {
      const pw = rw >> hshift(c), ph = rh >> vshift(c), data = new Int32Array(pw * ph), scale = dcScale[c], lift = dcLift[c];
      for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
        const at = blockAt(c, (x0 >> hshift(c)) + x, (y0 >> vshift(c)) + y);
        data[y * pw + x] = at < 0 ? 0 : comps[c].coeffs[at] * scale + lift;
      }
      return {w: pw, h: ph, data};
    });
    writeModularStream(w, planes, GRADIENT_PREDICTOR);
    const count = rw * rh, bits = ceilLog2(count);
    if (bits) w.write(bits, count - 1);
    const cw = (rw + 7) >> 3, ch = (rh + 7) >> 3;
    // Every block's strategy (DCT8, row 0) and quantisation field less one (row 1); a field above one is a constant row,
    // which the gradient predictor codes as one residual.
    const blocks = new Int32Array(count * 2).fill(field - 1, count);
    if (jpeg.quantFields) for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) blocks[count + y * rw + x] = jpeg.quantFields[(y0 + y) * xsizeBlocks + x0 + x] - 1;
    writeModularStream(w, [
      {w: cw, h: ch, data: new Int32Array(cw * ch)}, {w: cw, h: ch, data: new Int32Array(cw * ch)},
      {w: count, h: 2, data: blocks}, {w: rw, h: rh, data: new Int32Array(count)},
    ], field > 1 ? GRADIENT_PREDICTOR : ZERO_PREDICTOR);
    checkSection(1 + g);
    yield ++done / total;
  }

  // AC global: the JPEG's quantisation tables as the raw DCT8 matrices (transposed into the frame's layout), the
  // other kinds from the library, one histogram set, the natural coefficient order, the AC histograms.
  const ac = section(1 + numDcGroups);
  ac.write(1, 0);
  ac.write(3, 7); ac.write(16, float16Bits(field / (8 * 255 * quantScale)));
  writeModularStream(ac, [0, 1, 2].map(c => {
    const data = new Int32Array(64), quant = comps[c].quant;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) data[8 * x + y] = quant[8 * y + x];
    return {w: 8, h: 8, data};
  }), GRADIENT_PREDICTOR);
  for (let i = 1; i < 17; i++) ac.write(3, 0);
  if (numGroups > 1) ac.write(ceilLog2(numGroups), 0);
  if (plan.orders) {
    // DCT8 is order 0. Permutations name positions in the natural scan and are carried as a Lehmer code,
    // skipping DC. A prefix histogram may serve all eight permutation contexts.
    ac.writeU32([[0, 95], [0, 19], [0, 0], [13, 0]], 1);
    const values = [];
    for (const c of map) {
      const available = Array.from({length: 64}, (_, k) => k), lehmer = plan.orders[c].map(k => {
        const at = available.indexOf(k); available.splice(at, 1); return at;
      });
      let end = 64;
      while (end > 1 && !lehmer[end - 1]) end--;
      values.push(end - 1, ...lehmer.slice(1, end));
    }
    const config = uintConfig(0), freqs = new Uint32Array(64);
    for (const value of values) countToken(config, value, freqs);
    const code = buildCode(freqs);
    writeHistograms(ac, {contextMap: new Uint8Array(8), histograms: [{config, code}]});
    for (const value of values) writeHybrid(ac, code, config, value);
  } else ac.write(2, 2);
  if (coding.writeHistograms) coding.writeHistograms(ac);
  else writeHistograms(ac, {contextMap: coding.contextMap, histograms: coding.histograms});
  checkSection(1 + numDcGroups);

  for (let g = 0; g < numGroups; g++) {
    const w = section(2 + numDcGroups + g);
    tokens(g, (ctx, value) => coding.write(w, ctx, value));
    if (coding.flush) coding.flush(w);
    if (alpha && !single) writeModularStream(w, [alphaPlane(g % groupsX, Math.floor(g / groupsX))], GRADIENT_PREDICTOR);
    checkSection(2 + numDcGroups + g);
    yield ++done / total;
  }
  return assembleCodestream(header, finishSections(writers));
}
