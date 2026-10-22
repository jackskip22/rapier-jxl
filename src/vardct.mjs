// Rapier's JPEG XL encoder: a JPEG carried into a VarDCT frame. MIT (LICENSE).
import {BitWriter, float16Bits, packSigned, ceilLog2, complete} from './bits.mjs';
import {writeImageHeader, writeFrameHeaderEnd, finishSections, assembleCodestream, GROUP_DIM} from './frame.mjs';
import {ZERO_PREDICTOR, GRADIENT_PREDICTOR, ALPHABET, leaf, channelTree, writeTree, writeModularHeader, writeChannelHistograms, codeChannel} from './modular.mjs';
import {writeContextMap, writeHistograms, buildCode, uintConfig, countToken, writeHybrid, hybridToken} from './prefix.mjs';
import {TokenCounts, buildTokenCoding} from './entropy.mjs';
import {parseJPEG, jpegError, ZIGZAG} from './jfif.mjs';
import {admitOutputSize} from './admit.mjs';
import {losslessCoding} from './lossless-coding.mjs';

const NONZERO_BUCKETS = 37, ZERO_DENSITY_CONTEXTS = 458, ORDERS = 13;
const COEFF_FREQ_CONTEXT = [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 15, 16, 16, 17, 17, 18, 18, 19, 19, 20, 20, 21, 21, 22, 22,
  23, 23, 23, 23, 24, 24, 24, 24, 25, 25, 25, 25, 26, 26, 26, 26, 27, 27, 27, 27, 28, 28, 28, 28, 29, 29, 29, 29, 30, 30, 30, 30];
const COEFF_NUM_NONZERO_CONTEXT = [0, 0, 31, 62, 62, 93, 93, 93, 93, 123, 123, 123, 123, 152, 152, 152, 152, 152, 152, 152, 152, 180, 180, 180, 180, 180,
  180, 180, 180, 180, 180, 180, 180, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206, 206,
  206, 206, 206, 206, 206, 206, 206, 206];

const SCAN = ZIGZAG.map(n => ((n & 7) << 3) | (n >> 3));

export const zeroDensityContext = (left, k, prev) => (COEFF_NUM_NONZERO_CONTEXT[left] + COEFF_FREQ_CONTEXT[k]) * 2 + prev;

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

function writeBlockContexts(w, contexts) {
  w.write(4, contexts.thresholds.length);
  for (const t of contexts.thresholds) w.writeU32([[4, 0], [8, 16], [16, 272], [32, 65808]], packSigned(t));
  w.write(4, 0); w.write(4, 0);
  writeContextMap(w, contexts.map);
}

function plainCounts(bucketed, source, plain, grey) {
  const target = new TokenCounts(plain.contexts);
  const add = (from, to) => {
    target.totals[to] += source.totals[from];
    for (let v = 0; v < 64; v++) target.small[to * 64 + v] += source.small[from * 64 + v];
    if (source.large[from]) {
      const map = target.large[to] || (target.large[to] = new Map());
      for (const [value, count] of source.large[from]) map.set(value, (map.get(value) || 0) + count);
    }
  };
  for (let from = 0; from < bucketed.numCtxs; from++) {
    const to = from < bucketed.numDc ? 0 : grey || from < bucketed.numDc + ((bucketed.numDc - 1) >> 1) + 1 ? 1 : 2;
    for (let i = 0; i < NONZERO_BUCKETS; i++) add(i * bucketed.numCtxs + from, i * plain.numCtxs + to);
    for (let i = 0; i < ZERO_DENSITY_CONTEXTS; i++) add(bucketed.numCtxs * NONZERO_BUCKETS + from * ZERO_DENSITY_CONTEXTS + i,
      plain.numCtxs * NONZERO_BUCKETS + to * ZERO_DENSITY_CONTEXTS + i);
  }
  return target;
}

function writeModularStream(w, planes, predictor, ans) {
  const leaves = planes.map(() => leaf(predictor));
  const freqs = leaves.map(() => new Uint32Array(ALPHABET));
  const plans = ans && planes.map((p, i) => {
    const tags = new Uint32Array(p.data.length), extra = new Uint32Array(p.data.length), literals = new Map(), lengths = new Uint32Array(33), slots = [0, 0, 0];
    let used = 0;
    codeChannel(null, null, p.data, p.w, p.h, leaves[i], false, (value, config, base) => {
      hybridToken(config, value, slots);
      const symbol = base + slots[0]; freqs[i][symbol]++;
      tags[used] = symbol | (slots[1] << 9); extra[used++] = slots[2];
      if (base) lengths[slots[0]]++;
      else literals.set(value, (literals.get(value) || 0) + 1);
    });
    return {tags, extra, used, literals, lengths};
  });
  if (!ans) planes.forEach((p, i) => codeChannel(null, freqs[i], p.data, p.w, p.h, leaves[i]));
  writeModularHeader(w, {useGlobalTree: false, transforms: []});
  const ordered = writeTree(w, channelTree(leaves));
  const header = ans ? new BitWriter(256) : w;
  const histograms = writeChannelHistograms(header, ordered, freqs, l => leaves.indexOf(l));
  if (ans) {
    let prefixBits = header.bitLength;
    const models = plans.map((plan, c) => {
      for (let i = 0; i < plan.used; i++) prefixBits += histograms[c + 1].code.lengths[plan.tags[i] & 511] + ((plan.tags[i] >>> 9) & 63);
      const model = losslessCoding({literals: plan.literals, lengths: plan.lengths})[1], slots = [0, 0, 0];
      for (let i = 0; i < plan.used; i++) {
        const symbol = plan.tags[i] & 511;
        if (symbol >= 224) continue;
        hybridToken(model.config, symbol ? ((1 << (symbol - 1)) >>> 0) + plan.extra[i] : 0, slots);
        plan.tags[i] = slots[0] | (slots[1] << 9); plan.extra[i] = slots[2];
      }
      plan.freqs = [model.freqs];
      return model;
    });
    const candidate = new BitWriter(256);
    const write = ans(candidate, ordered, models.map(model => model.freqs), l => leaves.indexOf(l), i => models[i].config);
    if (candidate.bitLength + write.measure(plans) < prefixBits) { write(plans); w.append(candidate); return; }
    w.append(header);
  }
  planes.forEach((p, i) => codeChannel(w, histograms[i + 1].code, p.data, p.w, p.h, leaves[i]));
}

export function transcodeJPEG(bytes, jpeg = parseJPEG(bytes)) { return encodeVarDCT(jpeg); }

export function encodeVarDCT(jpeg, plan) { return complete(varDCTSteps(jpeg, plan)); }

export function* varDCTSteps(jpeg, plan = {}, shared) {
  if (shared && shared.jpeg !== jpeg) Object.assign(shared, {jpeg, blockCounts: null, dcSections: null, ansDcSections: null, modularAns: null, modular16bit: true});
  let modular16bit = (shared?.modular16bit ?? true) && jpeg.modular16bit !== false;
  const {width, height, components, alpha, auxiliary, xyb, strategyData, progression, noiseLut, splineBits, useDCFrame, authoredOrderPasses} = jpeg, grey = components.length === 1;
  const numPasses = progression?.count || 1;
  const epf = xyb ? jpeg.epf || 0 : 0;
  const quantScale = jpeg.quantScale || 1;
  let field = jpeg.quantFieldBase || 1;
  while (field / (8 * 255 * quantScale) < 1 / 16384) field *= 2;
  const ycbcr = !xyb && (jpeg.ycbcr || grey);
  const map = grey ? [0, 0, 0] : ycbcr ? [1, 0, 2] : [0, 1, 2];
  const comps = map.map(i => components[i]);
  const orders = plan.orders && !authoredOrderPasses ? map.map(i => plan.orders[i].map(k => SCAN[k])) : [SCAN, SCAN, SCAN];
  const log2 = v => v === 1 ? 0 : v === 2 ? 1 : -1;
  const minH = Math.min(...comps.map(c => c.h)), minV = Math.min(...comps.map(c => c.v));
  const rawH = comps.map(c => c.h % minH ? -1 : log2(c.h / minH)), rawV = comps.map(c => c.v % minV ? -1 : log2(c.v / minV));
  if (rawH.includes(-1) || rawV.includes(-1)) throw jpegError('sampling factors other than one or two');
  const maxhs = Math.max(...rawH), maxvs = Math.max(...rawV);
  const hshift = c => maxhs - rawH[c], vshift = c => maxvs - rawV[c];
  if (!ycbcr && (maxhs || maxvs)) throw jpegError('an RGB JPEG with subsampling');
  const xsizeBlocks = Math.ceil(width / (8 << maxhs)) << maxhs, ysizeBlocks = Math.ceil(height / (8 << maxvs)) << maxvs;
  const groupsX = Math.ceil(width / GROUP_DIM), groupsY = Math.ceil(height / GROUP_DIM), numGroups = groupsX * groupsY;
  const dcGroupsX = Math.ceil(xsizeBlocks / 256), dcGroupsY = Math.ceil(ysizeBlocks / 256), numDcGroups = dcGroupsX * dcGroupsY;
  const single = numGroups === 1 && numPasses === 1;
  const blockAt = (c, bx, by) => { const comp = comps[c]; if (grey && c !== 1) return -1; return ((by * comp.stride) + bx) * 64; };
  const dcAt = (c, bx, by) => strategyData ? comps[c].dc[by * comps[c].stride + bx] :
    blockAt(c, bx, by) < 0 ? 0 : comps[c].coeffs[blockAt(c, bx, by)];
  if (strategyData && (maxhs || maxvs || plan.orders && !authoredOrderPasses)) throw jpegError('variable transforms with subsampling or DCT8-only learned orders');

  const jpegReconstruction = jpeg.jpegReconstruction === true;
  const gcd1024 = q => { let d = 1024; while (q % d) d >>= 1; return d; };
  const dcScale = comps.map(c => ycbcr || xyb || jpegReconstruction ? 1 : c.quant[0] / gcd1024(c.quant[0]));
  const dcLift = comps.map(c => ycbcr || xyb ? 0 : jpegReconstruction ? Math.floor(1024 / c.quant[0]) : 1024 / gcd1024(c.quant[0]));
  const lumaW = xsizeBlocks >> hshift(1), lumaH = ysizeBlocks >> vshift(1), lumaDc = new Int32Array(lumaW * lumaH);
  for (let by = 0; by < lumaH; by++) for (let bx = 0; bx < lumaW; bx++) lumaDc[by * lumaW + bx] = dcAt(1, bx, by) * dcScale[1] + dcLift[1];
  const lumaQuant = comps[1].quant, quantSum = (lumaQuant[8] + lumaQuant[16] + lumaQuant[24] + lumaQuant[32] + lumaQuant[40]) / quantScale;
  const blocksTotal = xsizeBlocks * ysizeBlocks;
  const wanted = useDCFrame || blocksTotal < 256 ? 0 : Math.max(1, Math.min(7, ceilLog2(blocksTotal) - ceilLog2(quantSum) - 7));
  let contexts = blockContexts(lumaDc, wanted, grey);
  const lumaBuckets = Uint8Array.from(lumaDc, contexts.bucketOf);
  let contextHeader = new BitWriter(128);
  writeBlockContexts(contextHeader, contexts);

  const nzeros = [0, 1, 2].map(() => new Int32Array(32 * 32));
  let counted = !progression && !!shared?.blockCounts;
  const blockCounts = shared?.blockCounts || comps.map((comp, c) => grey && c !== 1 ? null : new Uint8Array(comp.coeffs.length / 64));
  const tokens = (g, emit, pass = 0) => {
    const authored = authoredOrderPasses?.[pass];
    const gx = g % groupsX, gy = (g / groupsX) | 0, bx0 = gx * 32, by0 = gy * 32;
    if (strategyData) {
      for (const block of strategyData.groups[g]) for (const c of [1, 0, 2]) {
        const {area, size, bw, bh} = block, order = authored?.byStrategy[block.id]?.[c] || block.order;
        const coeffs = block.coeffs[map[c]], bx = block.bx - bx0, by = block.by - by0;
        const coefficient = pos => progression ? progression.value(coeffs[pos], pos, Math.max(bw, bh) * 8, Math.min(bw, bh) * 8, pass) : coeffs[pos];
        let count = 0;
        for (let k = area; k < size; k++) if (coefficient(order[k])) count++;
        const row = nzeros[c], predicted = bx === 0 ? (by === 0 ? 32 : row[(by - 1) * 32]) : by === 0 ? row[bx - 1] :
          (row[(by - 1) * 32 + bx] + row[by * 32 + bx - 1] + 1) >> 1;
        const average = Math.ceil(count / area);
        for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) row[(by + y) * 32 + bx + x] = average;
        const bucket = contexts.thresholds.length ? lumaBuckets[block.by * lumaW + block.bx] : 0;
        const blockCtx = contexts.contextOf(c, bucket), offset = contexts.zeroDensityOffset(blockCtx);
        emit(contexts.nonZero(predicted, blockCtx), count);
        let prev = count > size / 16 ? 0 : 1, left = count;
        for (let k = area; k < size && left; k++) {
          const coeff = coefficient(order[k]);
          emit(offset + zeroDensityContext(Math.ceil(left / area), Math.floor(k / area), prev), packSigned(coeff));
          prev = coeff ? 1 : 0; left -= prev;
        }
      }
      return;
    }
    const bw = Math.min(32, xsizeBlocks - bx0), bh = Math.min(32, ysizeBlocks - by0);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) for (const c of [1, 0, 2]) {
      const hs = hshift(c), vs = vshift(c), sbx = bx >> hs, sby = by >> vs;
      if ((sbx << hs) !== bx || (sby << vs) !== by) continue;
      const at = blockAt(c, (bx0 >> hs) + sbx, (by0 >> vs) + sby), coeffs = comps[c].coeffs;
      let count = 0;
      if (at >= 0) {
        if (counted) count = blockCounts[c][at / 64];
        else {
          if (progression) {
            for (let k = 1; k < 64; k++) if (progression.value(coeffs[at + k], ((k & 7) << 3) | (k >> 3), 8, 8, pass)) count++;
          } else for (let k = 1; k < 64; k++) if (coeffs[at + k]) count++;
          blockCounts[c][at / 64] = count;
        }
      }
      const row = nzeros[c], predicted = sbx === 0 ? (sby === 0 ? 32 : row[(sby - 1) * 32]) : sby === 0 ? row[sby * 32 + sbx - 1] : (row[(sby - 1) * 32 + sbx] + row[sby * 32 + sbx - 1] + 1) >> 1;
      row[sby * 32 + sbx] = count;
      const bucket = contexts.thresholds.length ? lumaBuckets[((by0 + by) >> vshift(1)) * lumaW + ((bx0 + bx) >> hshift(1))] : 0;
      const blockCtx = contexts.contextOf(c, bucket);
      emit(contexts.nonZero(predicted, blockCtx), count);
      const offset = contexts.zeroDensityOffset(blockCtx);
      const coefficientOrder = authored?.ordinary?.[c] || orders[c];
      let prev = count > 4 ? 0 : 1, left = count;
      for (let k = 1; k < 64 && left; k++) {
        const pos = coefficientOrder[k], coeff = progression ? progression.value(coeffs[at + pos], ((pos & 7) << 3) | (pos >> 3), 8, 8, pass) : coeffs[at + pos];
        emit(offset + zeroDensityContext(left, k, prev), packSigned(coeff));
        prev = coeff ? 1 : 0; left -= prev;
      }
    }
  };
  const total = 2 * numGroups * numPasses + numDcGroups;
  let done = 0;
  const counts = Array.from({length: numPasses}, () => new TokenCounts(contexts.contexts)), buildCoding = plan.coding || buildTokenCoding;
  for (let p = 0; p < numPasses; p++) for (let g = 0; g < numGroups; g++) {
    tokens(g, (ctx, value) => counts[p].add(ctx, value), p); yield ++done / total;
  }
  counted = !progression;
  if (shared && !progression) shared.blockCounts = blockCounts;
  let codings = counts.map(count => buildCoding(count, plan.clusters));
  if (wanted > 0) {
    const plain = blockContexts(lumaDc, 0, grey), plainCodings = counts.map(count => buildCoding(plainCounts(contexts, count, plain, grey), plan.clusters)), plainHeader = new BitWriter(128);
    writeBlockContexts(plainHeader, plain);
    if (plainCodings.reduce((n, coding) => n + coding.bits, plainHeader.bitLength) <= codings.reduce((n, coding) => n + coding.bits, contextHeader.bitLength)) {
      codings = plainCodings; contexts = plain; contextHeader = plainHeader;
    }
  }

  const writers = Array.from({length: single ? 1 : 2 + numDcGroups + numGroups * numPasses}, () => null);
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
  if (splineBits) dc.append(splineBits);
  if (noiseLut) for (const value of noiseLut) dc.write(10, Math.round(value * 1024));
  dc.write(1, 0);

  const alphaPlane = (gx, gy) => {
    const x0 = gx * GROUP_DIM, y0 = gy * GROUP_DIM, w = Math.min(GROUP_DIM, width - x0), h = Math.min(GROUP_DIM, height - y0), data = new Int16Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = alpha[((y0 + y) * width + x0 + x) * 4 + 3];
    return {w, h, data};
  };
  for (let c = 0; c < 3; c++) dc.write(16, float16Bits(comps[c].quant[0] / dcScale[c] / (255 * 8 * quantScale) * 128));
  dc.write(2, 3); dc.write(16, 65536 - 8193);
  dc.write(2, 1); dc.write(5, 0);
  dc.write(1, 0); dc.write(4, 0);
  dc.append(contextHeader);
  if (xyb) dc.write(1, 1);
  else { dc.write(1, 0); dc.write(2, 0); dc.write(16, 0); dc.write(16, 0); dc.write(8, 128); dc.write(8, 128); }
  dc.write(1, 0);
  if (auxiliary) auxiliary.global(dc);
  else if (alpha) writeModularStream(dc, [numGroups === 1 ? alphaPlane(0, 0) : {w: 0, h: 0, data: new Int32Array(0)}], GRADIENT_PREDICTOR);
  checkSection(0);

  if (shared && plan.modularAns && shared.modularAns !== plan.modularAns) { shared.ansDcSections = null; shared.modularAns = plan.modularAns; }
  const sectionKey = plan.modularAns ? 'ansDcSections' : 'dcSections';
  const dcSections = shared && (shared[sectionKey] || (shared[sectionKey] = []));
  for (let g = 0; g < numDcGroups; g++) {
    if (dcSections?.[g]) {
      section(1 + g).append(dcSections[g]); checkSection(1 + g); yield ++done / total; continue;
    }
    const w = new BitWriter(4096), gx = g % dcGroupsX, gy = (g / dcGroupsX) | 0;
    const x0 = gx * 256, y0 = gy * 256, rw = Math.min(256, xsizeBlocks - x0), rh = Math.min(256, ysizeBlocks - y0);
    if (!useDCFrame) {
    w.write(2, 0);
    const planes = [1, 0, 2].map(c => {
      const pw = rw >> hshift(c), ph = rh >> vshift(c), scale = dcScale[c], lift = dcLift[c];
      let data = new Int16Array(pw * ph);
      for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
        const value = dcAt(c, (x0 >> hshift(c)) + x, (y0 >> vshift(c)) + y) * scale + lift;
        if (value < -32768 || value > 32767) {
          modular16bit = false;
          if (data instanceof Int16Array) data = Int32Array.from(data);
        }
        data[y * pw + x] = value;
      }
      return {w: pw, h: ph, data};
    });
    writeModularStream(w, planes, GRADIENT_PREDICTOR, plan.modularAns);
    }
    auxiliary?.group(w, gx * 2048, gy * 2048, 2048, 3, Infinity);
    const regionBlocks = strategyData && strategyData.blocks.filter(block => block.bx >= x0 && block.bx < x0 + rw && block.by >= y0 && block.by < y0 + rh)
      .sort((a, b) => a.by - b.by || a.bx - b.bx);
    const count = regionBlocks ? regionBlocks.length : rw * rh, bits = ceilLog2(rw * rh);
    if (bits) w.write(bits, count - 1);
    const cw = (rw + 7) >> 3, ch = (rh + 7) >> 3;
    const blocks = new Int32Array(count * 2).fill(field - 1, count);
    if (regionBlocks) for (let i = 0; i < count; i++) blocks[i] = regionBlocks[i].id;
    if (jpeg.quantFields && regionBlocks) for (let i = 0; i < count; i++) {
      const block = regionBlocks[i], value = jpeg.quantFields[block.by * xsizeBlocks + block.bx] - 1;
      blocks[count + i] = value;
      if (value < -32768 || value > 32767) modular16bit = false;
    }
    else if (jpeg.quantFields) for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
      const value = jpeg.quantFields[(y0 + y) * xsizeBlocks + x0 + x] - 1;
      blocks[count + y * rw + x] = value;
      if (value < -32768 || value > 32767) modular16bit = false;
    }
    else if (field - 1 < -32768 || field - 1 > 32767) modular16bit = false;
    const colors = [new Int16Array(cw * ch), new Int16Array(cw * ch)];
    if (xyb && jpeg.cfl) for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const at = ((y0 >> 3) + y) * jpeg.cfl.width + (x0 >> 3) + x;
      colors[0][y * cw + x] = jpeg.cfl.x[at]; colors[1][y * cw + x] = jpeg.cfl.b[at];
    }
    writeModularStream(w, [
      {w: cw, h: ch, data: colors[0]}, {w: cw, h: ch, data: colors[1]},
      {w: count, h: 2, data: blocks}, {w: rw, h: rh, data: epf ? new Int16Array(rw * rh).fill(7) : new Int16Array(rw * rh)},
    ], field > 1 ? GRADIENT_PREDICTOR : ZERO_PREDICTOR);
    section(1 + g).append(w); checkSection(1 + g);
    if (dcSections) { w.bytes = w.bytes.slice(0, w.at); dcSections[g] = w; }
    if (shared) shared.modular16bit = modular16bit;
    yield ++done / total;
  }

  const ac = section(1 + numDcGroups);
  ac.write(1, 0);
  for (let i = 0; i < 17; i++) {
    const table = strategyData?.tables.get(i);
    if (strategyData ? !table : i !== 0) { ac.write(3, 0); continue; }
    if (table?.parameters) { table.parameters.write(ac, map); continue; }
    ac.write(3, 7); ac.write(16, float16Bits(field / (8 * 255 * quantScale)));
    writeModularStream(ac, [0, 1, 2].map(c => {
      if (table) {
        const data = table.planes[map[c]];
        for (const value of data) if (value < -32768 || value > 32767) modular16bit = false;
        return {w: table.h, h: table.w, data};
      }
      const data = new Int32Array(64), quant = comps[c].quant;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const value = quant[8 * y + x]; data[8 * x + y] = value;
        if (value < -32768 || value > 32767) modular16bit = false;
      }
      return {w: 8, h: 8, data};
    }), table && table.w !== table.h ? ZERO_PREDICTOR : GRADIENT_PREDICTOR);
  }
  if (numGroups > 1) ac.write(ceilLog2(numGroups), 0);
  for (let pass = 0; pass < codings.length; pass++) {
  const coding = codings[pass];
  if (authoredOrderPasses) ac.append(authoredOrderPasses[pass].header);
  else if (plan.orders) {
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
  }
  checkSection(1 + numDcGroups);
  if (shared) shared.modular16bit = modular16bit;

  for (let p = 0; p < numPasses; p++) for (let g = 0; g < numGroups; g++) {
    const index = 2 + numDcGroups + p * numGroups + g, w = section(index), coding = codings[p];
    tokens(g, (ctx, value) => coding.write(w, ctx, value), p);
    if (coding.flush) coding.flush(w);
    if (auxiliary) {
      const bracket = progression?.brackets[p] ?? {minimum: 0, maximum: 2};
      auxiliary.group(w, g % groupsX * GROUP_DIM, Math.floor(g / groupsX) * GROUP_DIM, GROUP_DIM, bracket.minimum, bracket.maximum);
    }
    else if (alpha && numGroups > 1 && p === (progression?.alphaPass ?? 0)) writeModularStream(w, [alphaPlane(g % groupsX, Math.floor(g / groupsX))], GRADIENT_PREDICTOR);
    checkSection(index);
    yield ++done / total;
  }
  const header = new BitWriter(256);
  if (jpeg.frameHeader) jpeg.frameHeader(header);
  else {
  writeImageHeader(header, jpeg.canvasWidth ?? width, jpeg.canvasHeight ?? height, grey ? 1 : 3, !!alpha, {xyb, orientation: jpeg.orientation, colorSpace: jpeg.colorSpace, modular16bit, ...jpeg.profile});
  header.write(1, 0); header.write(2, 0); header.write(1, 0);
  header.write(2, 2); header.write(8, 128 + (noiseLut ? 1 : 0) + (splineBits ? 16 : 0) + (useDCFrame ? 32 : 0) - 17);
  if (!xyb) header.write(1, ycbcr ? 1 : 0);
  if (!useDCFrame) {
  if (ycbcr) for (let c = 0; c < 3; c++) header.write(2, rawH[c] === 0 && rawV[c] === 0 ? 0 : rawH[c] === 1 && rawV[c] === 1 ? 1 : rawH[c] === 1 ? 2 : 3);
  header.write(2, [1, 2, 4, 8].indexOf(jpeg.upsampling ?? 1));
  if (auxiliary) for (const factor of auxiliary.factors) header.write(2, [1, 2, 4, 8].indexOf(factor));
  else if (alpha) header.write(2, [1, 2, 4, 8].indexOf(jpeg.upsampling ?? 1));
  }
  if (xyb) { header.write(3, 2); header.write(3, 2); }
  writeFrameHeaderEnd(header, auxiliary?.count ?? alpha, epf, progression?.header);
  }
  return assembleCodestream(header, finishSections(writers), jpeg.level ?? 5);
}
