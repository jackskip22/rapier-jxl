// SPDX-License-Identifier: MIT
import {requireDecode as check, unpackSigned as signed} from './decode-bits.mjs';
import {readEntropy, readContextMap, readPermutation} from './decode-entropy.mjs';
import {decodeModularStream} from './decode-modular.mjs';
import {ceilLog2, COEFF_NUM_NONZERO_CONTEXT, COEFF_FREQ_CONTEXT} from './decode-tables.mjs';
import {TRANSFORMS, naturalOrder, prepareQuantParams, rcLlfFromDC} from './decode-strategies.mjs';
import {decodeKernels} from './decode-kernels.mjs';
import {inverseVarDCT, restoreFilters, restoreRows, restorationStages, scaledBasis, smoothLF} from './decode-vardct-transform.mjs';

export {restoreFilters};

const WIRE_ORDER = [1, 0, 2];
const ORDER_IDS = [0, 1, 1, 1, 2, 3, 4, 4, 5, 5, 6, 6, 1, 1, 1, 1, 1, 1, 7, 8, 8, 9, 10, 10, 11, 12, 12];
const FAMILY_IDS = [0, 1, 2, 3, 4, 5, 7, 9, 11, 12, 14, 18, 20, 21, 23, 24, 26];
const ORDER_SHAPES = [[1, 1], [1, 1], [2, 2], [4, 4], [2, 1], [4, 1], [4, 2], [8, 8], [8, 4], [16, 16], [16, 8], [32, 32], [32, 16]];
const DEFAULT_BIAS = [1 - .05465007330715401, 1 - .07005449891748593, 1 - .049935103337343655];

export function readVarDCTGlobal(r) {
  const globalScale = r.u32([[11, 1], [11, 2049], [12, 4097], [16, 8193]]);
  const quantLF = r.u32([[0, 16], [5, 1], [8, 1], [16, 1]]);
  const lfThresholds = [[], [], []], qfThresholds = [];
  let map;
  if (r.read(1)) {
    const y = [0, 1, 2, 2, 3, 3, 4, 5, 6, 6, 6, 6, 6];
    const chroma = [7, 8, 9, 9, 10, 11, 12, 13, 14, 14, 14, 14, 14];
    map = Uint8Array.from([...y, ...chroma, ...chroma]);
  } else {
    let bins = 1;
    for (const values of lfThresholds) {
      const count = r.read(4); bins *= count + 1;
      for (let i = 0; i < count; i++) values.push(signed(r.u32([[4, 0], [8, 16], [16, 272], [32, 65808]])));
    }
    const count = r.read(4); bins *= count + 1;
    for (let i = 0; i < count; i++) qfThresholds.push(1 + r.u32([[2, 0], [3, 4], [5, 12], [8, 44]]));
    check(bins <= 64, 'Too many JPEG XL block context bins.', r);
    map = readContextMap(r, bins * 39);
  }
  let clusters = 1;
  for (const value of map) clusters = Math.max(clusters, value + 1);
  check(clusters <= 16, 'Too many JPEG XL block contexts.', r);
  const correlation = {factor: 84, baseX: 0, baseB: 1, lfX: 128, lfB: 128};
  if (!r.read(1)) {
    correlation.factor = r.u32([[0, 84], [0, 256], [8, 2], [16, 258]]);
    correlation.baseX = r.f16(); correlation.baseB = r.f16();
    correlation.lfX = r.read(8); correlation.lfB = r.read(8);
  }
  return {globalScale, quantLF, lfThresholds, qfThresholds, map, clusters, correlation};
}

function readMatrixDescriptor(r, family, state) {
  const id = FAMILY_IDS[family], transform = TRANSFORMS[id], width = Math.max(transform.width, transform.height), height = Math.min(transform.width, transform.height);
  const mode = r.read(3), vector = count => Array.from({length: 3}, () => Array.from({length: count}, () => r.f16()));
  const bands = () => { const values = vector(r.read(4) + 1); for (const v of values) v[0] *= 64; return values; };
  check(mode < 1 || mode > 5 || width * height === 64, 'Invalid JPEG XL quantization mode for transform.');
  if (mode === 7) {
    const denominator = r.f16(); check(denominator > 0, 'Invalid JPEG XL raw quantization multiplier.');
    const channels = decodeModularStream(r, Array.from({length: 3}, () => ({width: height, height: width})), {
      globalTree: state.globalTree, bitDepth: state.bitDepth, groupDim: 256,
      streamIndex: 1 + state.numLFGroups * 3 + family,
      maxModularWork: state.maxModularWork, modularWork: state.modularWork,
    });
    const matrices = channels.map(ch => Float32Array.from(ch.data, v => {
      const weight = Math.fround(v * denominator), inverse = Math.fround(1 / weight);
      check(inverse >= Math.fround(1e-8) && inverse < 1e8, 'Invalid JPEG XL raw quantization weight.'); return weight;
    }));
    return {width, height, matrices};
  }
  const input = {mode: ['library', 'identity', 'dct2', 'dct4', 'dct4x8', 'afv', 'dct'][mode]};
  if (mode === 1 || mode === 2) { input.weights = vector(mode === 1 ? 3 : 6); for (const v of input.weights) for (let i = 0; i < v.length; i++) v[i] *= 64; }
  else if (mode === 3) { input.multipliers = vector(2); input.bands = bands(); }
  else if (mode === 4) { input.multipliers = vector(1).map(v => v[0]); input.bands = bands(); }
  else if (mode === 5) {
    input.weights = vector(9); for (const v of input.weights) for (let i = 0; i < 6; i++) v[i] *= 64;
    input.bands4x8 = bands(); input.bands4x4 = bands();
  } else if (mode === 6) input.bands = bands();
  return {width, height, input, family, matrices: null};
}

const LIBRARY_MATRICES = new Map();
function expandMatrix(descriptor) {
  if (!descriptor.matrices) {
    const {input, width, height, family} = descriptor, key = input.mode === 'library' ? family + ',' + width + ',' + height : null;
    descriptor.matrices = LIBRARY_MATRICES.get(key) ?? prepareQuantParams(input, width, height, family).weights.map(p => Float32Array.from(p, value => 1 / value));
    if (key) LIBRARY_MATRICES.set(key, descriptor.matrices);
  }
  return descriptor.matrices;
}

export function createVarDCT({width, height, header, global, lfDequant, bitDepth = 8, globalTree = null, imageHeader = {}, maxModularWork = 536870912, modularWork = {remaining: maxModularWork}, band = null, maxSection = 0}) {
  check(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0, 'Invalid JPEG XL VarDCT dimensions.');
  const sample = header.jpegUpsampling || [0, 0, 0];
  const hs = sample.map(v => v === 1 || v === 2 ? 1 : 0), vs = sample.map(v => v === 1 || v === 3 ? 1 : 0);
  const maxH = Math.max(...hs), maxV = Math.max(...vs), hshift = hs.map(v => maxH - v), vshift = vs.map(v => maxV - v);
  const blocksW = Math.ceil(width / (8 << maxH)) << maxH, blocksH = Math.ceil(height / (8 << maxV)) << maxV;
  const groupsX = Math.ceil(width / 256), groupsY = Math.ceil(height / 256), numGroups = groupsX * groupsY;
  const lfGroupsX = Math.ceil(width / 2048), lfGroupsY = Math.ceil(height / 2048), numLFGroups = lfGroupsX * lfGroupsY;
  const dcWidth = hshift.map(s => blocksW >> s), dcHeight = vshift.map(s => blocksH >> s);
  const dc = dcWidth.map((w, c) => new Int32Array(w * dcHeight[c]));
  const low = dc.map(p => new Float32Array(p.length));
  const metadata = new Array(numLFGroups), blockGroups = Array.from({length: numGroups}, () => []);
  const decodedLF = new Uint8Array(numLFGroups), decodedPass = [];
  const sigma = new Float32Array(blocksW * blocksH);
  const state = {width, height, header, global, lfDequant, bitDepth, globalTree, maxModularWork, modularWork, numGroups, numLFGroups, groupsX, groupsY, lfGroupsX, lfGroupsY};
  let matrices = null, passes = null, numPresets = 0;
  const arenas = new Array(numGroups), freeArenas = [];

  const lfKernels = () => matrices === null ? decodeKernels() : null;
  function readLF(r, group, {decodeExtraLF} = {}) {
    check(Number.isInteger(group) && group >= 0 && group < numLFGroups && !decodedLF[group], 'Invalid or repeated JPEG XL LF group.');
    const bx = group % lfGroupsX * 256, by = Math.floor(group / lfGroupsX) * 256;
    const bw = Math.min(256, blocksW - bx), bh = Math.min(256, blocksH - by);
    if (!header.useLFFrame) {
      const precision = r.read(2), order = [1, 0, 2];
      const channels = decodeModularStream(r, order.map(c => ({width: bw >> hshift[c], height: bh >> vshift[c]})), {
        globalTree: state.globalTree, bitDepth, streamIndex: 1 + group, groupDim: 0,
        maxModularWork: state.maxModularWork, modularWork: state.modularWork, kernels: lfKernels(),
      });
      for (let channel = 0; channel < 3; channel++) {
        const c = order[channel], data = channels[channel].data, cw = bw >> hshift[c], ch = bh >> vshift[c];
        const scale = Math.fround(lfDequant[c] * (1 << (9 - precision)) / (global.globalScale * global.quantLF));
        for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
          const dest = ((by >> vshift[c]) + y) * dcWidth[c] + (bx >> hshift[c]) + x, value = data[y * cw + x];
          dc[c][dest] = value; low[c][dest] = value * scale;
        }
      }
    }
    decodeExtraLF?.(r, group);
    const count = r.read(ceilLog2(bw * bh)) + 1;
    check(count <= bw * bh, 'JPEG XL transform count exceeds its LF group.');
    const cw = Math.ceil(Math.min(2048, width - bx * 8) / 64), ch = Math.ceil(Math.min(2048, height - by * 8) / 64);
    const values = decodeModularStream(r, [{width: cw, height: ch}, {width: cw, height: ch}, {width: count, height: 2}, {width: bw, height: bh}], {
      globalTree: state.globalTree, bitDepth, streamIndex: 1 + 2 * numLFGroups + group, groupDim: 0,
      maxModularWork: state.maxModularWork, modularWork: state.modularWork, kernels: lfKernels(),
    });
    const xFromY = values[0].data, bFromY = values[1].data, info = values[2].data, sharpness = values[3].data;
    const occupied = new Int32Array(bw * bh).fill(-1), starts = new Uint8Array(bw * bh), blocks = [];
    let index = 0;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      if (occupied[y * bw + x] !== -1) continue;
      check(index < count, 'JPEG XL transform map does not cover its LF group.');
      const id = info[index], multiplier = info[count + index] + 1, transform = TRANSFORMS[id];
      check(transform && multiplier > 0, 'Invalid JPEG XL transform or quantization multiplier.');
      const w = transform.width / 8, h = transform.height / 8;
      check(x + w <= bw && y + h <= bh && (x & 31) + w <= 32 && (y & 31) + h <= 32, 'JPEG XL transform crosses its group.');
      const gx = bx + x, gy = by + y;
      const epf = header.filter?.epf;
      for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
        const pos = (y + dy) * bw + x + dx;
        check(occupied[pos] === -1, 'Overlapping JPEG XL transforms.'); occupied[pos] = index;
        if (epf?.iters) {
          const sharp = sharpness[pos]; check(sharp >= 0 && sharp < 8, 'Invalid JPEG XL filter sharpness.');
          const lut = epf.sharpLut || [0, 1 / 7, 2 / 7, 3 / 7, 4 / 7, 5 / 7, 6 / 7, 1];
          sigma[(gy + dy) * blocksW + gx + dx] = (epf.quantMul ?? .46) * 65536 / global.globalScale / multiplier * lut[sharp];
        }
      }
      starts[y * bw + x] = 1;
      if (!band || (gy >> 5) >= band.first && (gy >> 5) < band.end) {
        const block = {id, x: gx, y: gy, bw: w, bh: h, area: w * h, multiplier, coefficients: [null, null, null], lfGroup: group};
        blocks.push(block); blockGroups[(gy >> 5) * groupsX + (gx >> 5)].push(block);
      }
      index++;
    }
    check(index === count, 'Unused JPEG XL transform map entries.');
    metadata[group] = {xFromY, bFromY, width: cw, bw, bh, starts, blocks, bx, by};
    decodedLF[group] = 1;
  }

  function readHFGlobal(r) {
    check(matrices === null, 'Repeated JPEG XL HF global section.');
    const allDefault = r.read(1);
    matrices = FAMILY_IDS.map((id, family) => {
      if (!allDefault) return readMatrixDescriptor(r, family, state);
      const t = TRANSFORMS[id]; return {width: Math.max(t.width, t.height), height: Math.min(t.width, t.height), input: {mode: 'library'}, family, matrices: null};
    });
    numPresets = r.read(ceilLog2(numGroups)) + 1;
    check(numPresets <= numGroups, 'Too many JPEG XL HF presets.');
    const count = header.passes?.count || 1;
    passes = Array.from({length: count}, () => {
      const used = r.u32([[0, 95], [0, 19], [0, 0], [13, 0]]), orders = ORDER_SHAPES.map(([w, h]) => [0, 1, 2].map(() => naturalOrder(w, h)));
      if (used) {
        const code = readEntropy(r, 8, {values: 3 * ORDER_SHAPES.reduce((sum, [w, h]) => sum + w * h * 64 + 1, 0)});
        for (let order = 0; order < 13; order++) if (used & (1 << order)) {
          const [w, h] = ORDER_SHAPES[order], size = w * h * 64, natural = naturalOrder(w, h);
          for (let c = 0; c < 3; c++) orders[order][c] = Uint32Array.from(readPermutation(code, size, w * h), i => natural[i]);
        }
        code.finish();
      }
      return {orders, entropy: readEntropy(r, 495 * numPresets * global.clusters)};
    });
    for (let p = 0; p < count; p++) decodedPass.push(new Uint8Array(numGroups));
    reserveKernelMemory();
  }

  let kernelRegions = null, entropyKernel = null, kernelWeights = null;
  const ENTROPY_FAULTS = ['', 'Invalid JPEG XL entropy read.', 'Truncated JPEG XL data.', 'JPEG XL integer exceeds 32 bits.', 'JPEG XL coefficient overflows its range.'];
  function kernelCoefficients(code, values, offset, n, pass, orderID, c, area, base, remaining, previous, scale) {
    const K = entropyKernel, {kernels, io32: io} = K, r = code.reader;
    if (K.reader !== r) {
      const bytes = new Uint8Array(kernels.buffer, K.bytes, r.bytes.length + 16);
      bytes.set(r.bytes); bytes.fill(0, r.bytes.length); K.reader = r;
    }
    const inPlace = values.buffer === kernels.buffer, at = inPlace ? values.byteOffset + offset * 4 : K.values;
    if (!inPlace) new Int32Array(kernels.buffer, K.values, n).set(values);
    const budget = Math.min(code.remaining, 0x7fffffff), tables = K.tables[pass];
    io[0] = at; io[1] = n; io[2] = area; io[3] = 31 - Math.clz32(area); io[4] = K.orders[pass][orderID][c]; io[5] = base; io[6] = remaining;
    io[7] = previous; io[8] = scale; io[9] = code.state; io[10] = r.bit; io[11] = K.bytes; io[12] = r.bytes.length * 8; io[13] = budget;
    io[14] = tables.map; io[15] = tables.contexts; io[16] = tables.tables; io[17] = K.nonzero; io[18] = K.frequency;
    const fault = kernels.blockCoefficients(K.io), used = budget - io[13];
    code.remaining -= used; code.position += used; code.state = io[9] >>> 0; r.bit = io[10];
    if (fault) check(false, ENTROPY_FAULTS[fault], r);
    if (!inPlace) values.set(new Int32Array(kernels.buffer, K.values, n));
    return io[6];
  }
  function reserveKernelMemory() {
    const kernels = decodeKernels();
    if (!kernels) return;
    const stages = restorationStages(header.filter), slots = Math.max(1, stages.length), restoring = streams && (radius || band), rows = Math.min(height, 256 + 2 * radius), plane = rows * width * 4;
    const sigmaLength = Math.ceil(width / 8) * Math.ceil(height / 8);
    const models = passes.map(p => p.entropy.model), simple = models.every(m => !m.lz && !m.prefix && m.codes.every(c => c.counts.length <= 256)) && maxSection < 0x8000000;
    const orderSize = ORDER_SHAPES.reduce((n, [w, h]) => n + 3 * w * h * 64, 0) * 4;
    const sizes = [...(restoring ? [...Array(6 + 3 * slots).fill(plane), 21 * width * 8, width * 8, width * 8, sigmaLength * 4, 32, 256 * width * 4, 256 * width * 4] : []),
      ...(simple ? [...models.flatMap(m => [m.codes.length * 12816, m.map.length]), passes.length * orderSize, 1024, 65536 * 4, maxSection + 16, 128] : []),
      ...(simple && passes.length === 1 ? [groupsX * 3 * 65536 * 4] : []),
      matrices.reduce((n, m) => n + m.width * m.height * 12, 0)];
    if (!sizes.length) return;
    const at = kernels.reserve(sizes);
    if (restoring) kernelRegions = {at, rows, stages};
    let weightsAt = at.at(-1);
    kernelWeights = {kernels, offsets: matrices.map(m => { const offset = weightsAt; weightsAt += m.width * m.height * 12; return offset; }), loaded: matrices.map(() => false)};
    if (simple) {
      let k = restoring ? 13 + 3 * slots : 0;
      const u8 = new Uint8Array(kernels.buffer), u16 = new Uint16Array(kernels.buffer), u32 = new Uint32Array(kernels.buffer);
      const tables = models.map(m => {
        const tableAt = at[k++], mapAt = at[k++];
        m.codes.forEach((code, c) => {
          const t = tableAt + c * 12816, config = m.configs[c];
          u8.set(code.symbols, t); u16.set(code.offsets, (t + 4096) / 2); u16.set(code.counts, (t + 12288) / 2);
          u8[t + 12800] = config.split; u8[t + 12801] = config.msb; u8[t + 12802] = config.lsb;
        });
        u8.set(m.map, mapAt);
        return {tables: tableAt, map: mapAt, contexts: m.contexts};
      });
      const ordersAt = at[k++], contextsAt = at[k++];
      const orders = passes.map((p, pass) => {
        let o = ordersAt + pass * orderSize;
        return p.orders.map(shape => shape.map(order => { const offset = o; u32.set(order, o / 4); o += order.length * 4; return offset; }));
      });
      u16.set(COEFF_NUM_NONZERO_CONTEXT, contextsAt / 2); u16.set(COEFF_FREQ_CONTEXT, (contextsAt + 512) / 2);
      entropyKernel = {tables, orders, nonzero: contextsAt, frequency: contextsAt + 512, values: at[k++], bytes: at[k++], io: at[k++], reader: null, kernels};
      entropyKernel.io32 = new Int32Array(kernels.buffer, entropyKernel.io, 32);
      if (passes.length === 1) for (let g = 0; g < groupsX; g++) freeArenas.push(new Int32Array(kernels.buffer, at[k] + g * 3 * 65536 * 4, 3 * 65536).fill(0));
    }
  }

  function readPassGroup(r, group, pass) {
    check(passes && Number.isInteger(group) && group >= 0 && group < numGroups && Number.isInteger(pass) && pass >= 0 && pass < passes.length && !decodedPass[pass][group], 'Invalid or repeated JPEG XL coefficient group.');
    const groupX = group % groupsX * 32, groupY = Math.floor(group / groupsX) * 32, gbw = Math.min(32, blocksW - groupX);
    const lfg = Math.floor(groupY / 256) * lfGroupsX + Math.floor(groupX / 256);
    check(decodedLF[lfg], 'JPEG XL LF metadata is absent.');
    const preset = r.read(ceilLog2(numPresets)); check(preset < numPresets, 'Invalid JPEG XL HF preset.');
    const code = passes[pass].entropy.start(r), prefix = preset * global.clusters * 495;
    const nonzero = hshift.map(s => new Uint32Array(gbw >> s));
    const shift = header.passes?.shift?.[pass] || 0, scale = 1 << shift;
    const lfBins = global.lfThresholds.reduce((n, t) => n * (t.length + 1), 1), hfBins = global.qfThresholds.length + 1;
    for (const block of blockGroups[group]) {
      const {id, area, multiplier} = block, {width: tw, height: th} = TRANSFORMS[id], orderID = ORDER_IDS[id];
      let lowBucket = 0;
      if (!header.useLFFrame) for (const c of [0, 2, 1]) {
        const thresholds = global.lfThresholds[c], value = dc[c][(block.y >> vshift[c]) * dcWidth[c] + (block.x >> hshift[c])];
        lowBucket *= thresholds.length + 1;
        for (const threshold of thresholds) if (value > threshold) lowBucket++;
      }
      let highBucket = 0; for (const threshold of global.qfThresholds) if (multiplier > threshold) highBucket++;
      for (let wire = 0; wire < 3; wire++) {
        const c = [1, 0, 2][wire], sx = (block.x - groupX) >> hshift[c], sy = (block.y - groupY) >> vshift[c];
        if (sx * (1 << hshift[c]) !== block.x - groupX || sy * (1 << vshift[c]) !== block.y - groupY) continue;
        const meta = metadata[lfg];
        if ((hshift[c] || vshift[c]) && !meta.starts[((groupY & 255) + sy) * meta.bw + (groupX & 255) + sx]) continue;
        const row = nonzero[c]; check(sx + block.bw <= row.length, 'Invalid subsampled JPEG XL transform.');
        const context = global.map[((wire * 13 + orderID) * hfBins + highBucket) * lfBins + lowBucket];
        check(context !== undefined, 'Invalid JPEG XL block context.');
        const prediction = sx ? sy ? (row[sx] + row[sx - 1] + 1) >> 1 : row[sx - 1] : sy ? row[sx] : 32;
        check(prediction < 64, 'Invalid JPEG XL nonzero predictor.');
        let remaining = code.read(prefix + (prediction < 8 ? prediction : 4 + (prediction >> 1)) * global.clusters + context);
        check(remaining <= area * 63, 'JPEG XL nonzero count exceeds transform.');
        const density = Math.ceil(remaining / area); row.fill(density, sx, sx + block.bw);
        let values = block.coefficients[c];
        if (values == null) {
          const arena = arenas[group] ??= {data: freeArenas.pop()?.fill(0) ?? new Int32Array(3 * 65536), used: 0};
          check(arena.used + tw * th <= arena.data.length, 'JPEG XL group coefficients exceed the group.');
          if (entropyKernel && arena.data.buffer === entropyKernel.kernels.buffer) { block.arena = arena.data; values = block.coefficients[c] = arena.used; arena.used += tw * th; }
          else block.coefficients[c] = values = arena.data.subarray(arena.used, arena.used += tw * th);
        }
        let previous = remaining <= area * 4 ? 1 : 0;
        const order = passes[pass].orders[orderID][c], base = prefix + global.clusters * 37 + context * 458, logArea = 31 - Math.clz32(area);
        if (typeof values === 'number') {
          remaining = code.state !== null && !code.finished ? kernelCoefficients(code, block.arena, values, tw * th, pass, orderID, c, area, base, remaining, previous, scale)
            : code.blockCoefficients(block.arena.subarray(values, values + tw * th), order, area, base, remaining, previous, scale);
          check(!remaining, 'JPEG XL coefficient count is incomplete.');
          continue;
        }
        const size = values.length;
        const fast = entropyKernel && code.state !== null && !code.finished ? kernelCoefficients(code, values, 0, size, pass, orderID, c, area, base, remaining, previous, scale)
          : code.blockCoefficients(values, order, area, base, remaining, previous, scale);
        if (fast >= 0) remaining = fast;
        else for (let k = area; k < size && remaining; k++) {
          const token = code.read(base + (COEFF_NUM_NONZERO_CONTEXT[((remaining - 1) >> logArea) + 1] + COEFF_FREQ_CONTEXT[((k - area) >> logArea) + 1]) * 2 + previous);
          const value = token & 1 ? -(token + 1) / 2 : token / 2, at = order[k], sum = values[at] + value * scale;
          if (!(sum >= -2147483648 && sum <= 2147483647)) check(false, 'JPEG XL coefficient overflows its range.');
          values[at] = sum; previous = value !== 0 ? 1 : 0; remaining -= previous;
        }
        check(!remaining, 'JPEG XL coefficient count is incomplete.');
      }
    }
    code.finish(); decodedPass[pass][group] = 1;
  }

  let prepared = null, rendered = 0, pending = null;
  const streams = !maxH && !maxV, radius = streams ? restorationStages(header.filter).reduce((n, s) => n + s.radius, 0) : 0;
  function prepare(lfReference) {
    let lf;
    if (header.useLFFrame) {
      check(lfReference?.planes?.length === 3, 'JPEG XL LF reference is absent.');
      lf = lfReference.planes.map((p, c) => {
        const sourceWidth = lfReference.widths?.[c] ?? lfReference.width ?? dcWidth[c];
        const sourceHeight = lfReference.heights?.[c] ?? lfReference.height ?? dcHeight[c];
        check(sourceWidth >= dcWidth[c] && sourceHeight >= dcHeight[c] && p.length >= sourceWidth * sourceHeight, 'JPEG XL LF reference is too small.');
        const values = new Float32Array(low[c].length);
        for (let y = 0; y < dcHeight[c]; y++) values.set(p.subarray(y * sourceWidth, y * sourceWidth + dcWidth[c]), y * dcWidth[c]);
        return values;
      });
    } else {
      lf = low.map(p => Float32Array.from(p));
      if (!maxH && !maxV) {
        const corr = global.correlation, x = corr.baseX + (corr.lfX - 128) / corr.factor, b = corr.baseB + (corr.lfB - 128) / corr.factor;
        for (let i = 0; i < lf[1].length; i++) { lf[0][i] += x * lf[1][i]; lf[2][i] += b * lf[1][i]; }
      }
      if (!header.skipAdaptiveLFSmoothing) lf = smoothLF(lf, dcWidth, dcHeight, hshift, vshift, lfDequant.map(m => 512 * m / (global.globalScale * global.quantLF)));
    }
    const widths = hshift.map(s => Math.ceil(width / (1 << s))), heights = vshift.map(s => Math.ceil(height / (1 << s)));
    const tightSigma = blocksW === Math.ceil(width / 8) ? sigma : Float32Array.from({length: Math.ceil(width / 8) * Math.ceil(height / 8)}, (_, i) => sigma[Math.floor(i / Math.ceil(width / 8)) * blocksW + i % Math.ceil(width / 8)]);
    prepared = {lf, widths, heights, tightSigma,
      planes: band ? null : widths.map((w, c) => new Float32Array(w * heights[c])),
      bias: imageHeader.opsinInverseMatrix?.quantBias || DEFAULT_BIAS, numerator: imageHeader.opsinInverseMatrix?.quantBiasNumerator ?? .145,
      qmScale: [header.xQmScale ?? 3, 2, header.bQmScale ?? 2].map(s => { let v = 1; for (let i = 2; i < s; i++) v *= .8; for (let i = s; i < 2; i++) v /= .8; return v; }),
      scratch: decodeKernels()?.coefficients ?? [0, 1, 2].map(() => new Float64Array(64)), result: new Float64Array(64), means: new Float64Array(1024),
      tileOfU: new Int32Array(256), tileOfV: new Int32Array(256), restoration: [], stripes: null, blockPlanes: [null, null, null]};
    if (streams && (radius || band)) {
      const rows = Math.min(height, 256 + 2 * radius), plane = rows * width * 4, stages = restorationStages(header.filter), kernels = decodeKernels();
      if (kernels && kernelRegions) {
        const {at} = kernelRegions;
        const planes = from => [0, 1, 2].map(c => new Float32Array(kernels.buffer, at[from + c], rows * width));
        prepared.stripes = [planes(0), planes(3)];
        for (let i = 0; i < stages.length - 1; i++) prepared.restoration[i] = planes(6 + 3 * i);
        const k = 6 + 3 * Math.max(1, stages.length);
        prepared.restoration.kernel = {final: planes(k - 3), ring: at[k], up: at[k + 1], down: at[k + 2], sigma: at[k + 3], args: at[k + 4], rgba: at[k + 5]};
        kernels.list = at[k + 6];
        if (band) band.kernel = prepared.restoration.kernel;
        new Float32Array(kernels.buffer, at[k + 3], prepared.tightSigma.length).set(prepared.tightSigma);
        prepared.scratch = kernels.coefficients;
      } else prepared.stripes = [0, 1].map(() => [0, 1, 2].map(() => new Float32Array(rows * width)));
    }
    return prepared;
  }

  function renderBlock(block, targets, tops) {
    const P = prepared, {lf, widths, heights, bias, numerator, qmScale, means, tileOfU, tileOfV} = P, group = metadata[block.lfGroup];
    const {id, area, multiplier, bw, bh} = block, shape = TRANSFORMS[id], size = area * 64, quant = expandMatrix(matrices[shape.table]);
    if (P.scratch[0].length < size) for (let c = 0; c < 3; c++) P.scratch[c] = new Float64Array(size);
    if (P.result.length < size) P.result = new Float64Array(size);
    const coefficients = P.blockPlanes, wide = Math.max(shape.width, shape.height);
    coefficients[0] = coefficients[1] = coefficients[2] = null;
    const transpose = !(id === 1 || id === 2 || id === 3 || id >= 12 && id <= 17) && shape.height >= shape.width;
    const cflBlock = !maxH && !maxV, held = block.coefficients, K = kernelWeights;
    if (id === 0 && cflBlock && K && typeof held[0] === 'number' && typeof held[1] === 'number' && typeof held[2] === 'number' &&
      P.scratch[0].buffer === K.kernels.buffer && targets[0].buffer === K.kernels.buffer && targets[1].buffer === K.kernels.buffer && targets[2].buffer === K.kernels.buffer) {
      const {kernels, offsets, loaded} = K, table = shape.table, arena = block.arena.byteOffset, scale = 65536 / (global.globalScale * multiplier);
      if (!loaded[table]) { for (let k = 0; k < 3; k++) new Float32Array(kernels.buffer, offsets[table] + k * 256, 64).set(quant[k]); loaded[table] = true; }
      const tile = (Math.floor(block.y * 8 / 64) - (group.by >> 3)) * group.width + Math.floor(block.x * 8 / 64) - (group.bx >> 3), at = block.y * dcWidth[0] + block.x;
      const x0 = block.x * 8, y0 = block.y * 8, w = widths[0], xs = Math.min(8, w - x0), ys = Math.min(8, heights[0] - y0);
      kernels.block8(arena + held[0] * 4, arena + held[1] * 4, arena + held[2] * 4, offsets[table], scale * qmScale[0], scale * qmScale[1], scale * qmScale[2],
        bias[0], bias[1], bias[2], numerator, global.correlation.baseX + group.xFromY[tile] / global.correlation.factor,
        global.correlation.baseB + group.bFromY[tile] / global.correlation.factor, lf[0][at], lf[1][at], lf[2][at],
        targets[0].byteOffset + ((y0 - tops[0]) * w + x0) * 4, targets[1].byteOffset + ((y0 - tops[1]) * w + x0) * 4, targets[2].byteOffset + ((y0 - tops[2]) * w + x0) * 4,
        w * 4, xs, ys, kernels.basis(8, () => scaledBasis(8)));
      block.coefficients = block.arena = null;
      return;
    }
    if (cflBlock) {
      const columns = size / wide;
      for (let u = 0; u < wide; u++) { const px = block.x * 8 + (transpose ? 0 : u), py = block.y * 8 + (transpose ? u : 0); tileOfU[u] = transpose ? Math.floor(py / 64) - (group.by >> 3) : Math.floor(px / 64) - (group.bx >> 3); }
      for (let v = 0; v < columns; v++) { const px = block.x * 8 + (transpose ? v : 0), py = block.y * 8 + (transpose ? 0 : v); tileOfV[v] = transpose ? Math.floor(px / 64) - (group.bx >> 3) : Math.floor(py / 64) - (group.by >> 3); }
    }
    for (let wire = 0; wire < 3; wire++) {
      const c = WIRE_ORDER[wire], held = block.coefficients[c]; if (held == null) continue;
      const values = P.scratch[c], factor = 65536 / (global.globalScale * multiplier) * qmScale[c], q8 = quant[c], b = bias[c];
      const inKernel = typeof held === 'number' || held.buffer === kernelWeights?.kernels.buffer;
      if (kernelWeights && inKernel && values.buffer === kernelWeights.kernels.buffer) {
        const {kernels, offsets, loaded} = kernelWeights, table = shape.table;
        if (!loaded[table]) { for (let k = 0; k < 3; k++) new Float32Array(kernels.buffer, offsets[table] + k * size * 4, size).set(quant[k]); loaded[table] = true; }
        kernels.dequant(typeof held === 'number' ? block.arena.byteOffset + held * 4 : held.byteOffset, size, offsets[table] + c * size * 4, factor, b, numerator, values.byteOffset);
      } else for (let i = 0, ints = typeof held === 'number' ? block.arena.subarray(held, held + size) : held; i < size; i++) {
        const q = ints[i];
        values[i] = q === 0 ? 0 * b : (Math.abs(q) <= 1 ? q * b : q - numerator / q) * q8[i] * factor;
      }
      if (c !== 1 && cflBlock) {
        const cfl = c === 0 ? group.xFromY : group.bFromY, base = c === 0 ? global.correlation.baseX : global.correlation.baseB, luma = coefficients[1];
        if (size === 64) {
          const corr = base + cfl[transpose ? tileOfU[0] * group.width + tileOfV[0] : tileOfV[0] * group.width + tileOfU[0]] / global.correlation.factor;
          if (kernelWeights && values.buffer === kernelWeights.kernels.buffer && luma.buffer === values.buffer) kernelWeights.kernels.cfl64(values.byteOffset, luma.byteOffset, corr);
          else for (let i = 0; i < 64; i++) { const y = luma[i]; if (y !== 0) values[i] += corr * y; }
        } else for (let i = 0, v = 0; i < size; v++) for (let u = 0; u < wide; u++, i++) {
          const y = luma[i]; if (y === 0) continue;
          const ci = transpose ? tileOfU[u] * group.width + tileOfV[v] : tileOfV[v] * group.width + tileOfU[u];
          values[i] += (base + cfl[ci] / global.correlation.factor) * y;
        }
      }
      const bx = block.x >> hshift[c], by = block.y >> vshift[c], plane = lf[c], stride = dcWidth[c];
      if (area === 1) values[0] = 0 + plane[by * stride + bx];
      else {
        const m = means.subarray(0, area);
        for (let i = 0; i < area; i++) m[i] = plane[(by + Math.floor(i / bw)) * stride + bx + i % bw];
        const llf = rcLlfFromDC(m, bw, bh), canonWidth = Math.max(bw, bh) * 8, llfWidth = Math.max(bw, bh);
        for (let i = 0; i < area; i++) values[Math.floor(i / llfWidth) * canonWidth + i % llfWidth] = llf[i];
      }
      coefficients[c] = values;
    }
    block.coefficients = block.arena = null;
    const kernels = decodeKernels();
    for (let c = 0; c < 3; c++) if (coefficients[c]) {
      const out = inverseVarDCT(coefficients[c], id, P.result), x0 = (block.x >> hshift[c]) * 8, y0 = (block.y >> vshift[c]) * 8;
      const w = widths[c], p = targets[c], xs = Math.min(shape.width, w - x0), ys = Math.min(shape.height, heights[c] - y0);
      if (kernels && out === kernels.output && p.buffer === kernels.buffer) { if (xs > 0 && ys > 0) kernels.store(shape.width, p, (y0 - tops[c]) * w + x0, w, xs, ys); }
      else for (let y = 0; y < ys; y++) { const o = (y0 + y - tops[c]) * w + x0, i = y * shape.width; for (let x = 0; x < xs; x++) p[o + x] = out[i + x]; }
    }
  }

  if (band) {
    check(streams && band.first >= 0 && band.first < band.end && band.end <= groupsY, 'Invalid JPEG XL band.');
    rendered = band.first;
    band.top = band.first * 256; band.bottom = Math.min(height, band.end * 256);
    band.deferTop = band.first > 0 ? Math.min(band.bottom, band.top + radius) : band.top;
    band.deferBottom = band.end < groupsY ? Math.max(band.deferTop, band.bottom - radius) : band.bottom;
    band.kept = [];
  }
  function restoreStripe(stripe, a, b) {
    if (a >= b) return;
    if (!band) return restoreRows(stripe.planes, stripe.lo, width, height, header.filter, prepared.tightSigma, prepared.planes, 0, a, b, prepared.restoration);
    const output = band.kernel ? band.kernel.final.map(p => p.subarray(0, (b - a) * width)) : band.target(a, b);
    restoreRows(stripe.planes, stripe.lo, width, height, header.filter, prepared.tightSigma, output, a, a, b, prepared.restoration);
    band.restored(a, b, output);
  }
  function keepRows(stripe, a, b) {
    if (a < b) band.kept.push({top: a, planes: stripe.planes.map(p => p.slice((a - stripe.lo) * width, (b - stripe.lo) * width))});
  }
  function renderRow(k, lfReference) {
    check(k === rendered && k < (band ? band.end : groupsY), 'JPEG XL group rows render in order.');
    const P = prepared ?? prepare(lfReference), blocks = [];
    for (let g = k * groupsX; g < (k + 1) * groupsX; g++) blocks.push(...blockGroups[g]);
    rendered++;
    const release = () => { for (let g = k * groupsX; g < (k + 1) * groupsX; g++) if (arenas[g]) { freeArenas.push(arenas[g].data); arenas[g] = null; } };
    if (!streams || !radius && !band) { for (const block of blocks) renderBlock(block, P.planes, [0, 0, 0]); release(); return; }
    const top = k * 256, bottom = Math.min(height, top + 256), lo = Math.max(0, top - radius), hi = Math.min(height, bottom + radius);
    const stripe = {top, bottom, lo, hi, planes: P.stripes[k & 1]};
    for (const block of blocks) renderBlock(block, stripe.planes, [lo, lo, lo]);
    release();
    const last = rendered === (band ? band.end : groupsY);
    if (band) {
      if (k === band.first) keepRows(stripe, top, Math.min(bottom, top + 2 * radius));
      if (last) keepRows(stripe, Math.max(top, bottom - 2 * radius), bottom);
    }
    const from = band ? band.deferTop : 0, to = band ? band.deferBottom : height;
    if (pending) {
      const copyRows = (from, to, a, b) => { for (let c = 0; c < 3; c++) to.planes[c].set(from.planes[c].subarray((a - from.lo) * width, (b - from.lo) * width), (a - to.lo) * width); };
      copyRows(stripe, pending, top, pending.hi); copyRows(pending, stripe, lo, top);
      restoreStripe(pending, Math.max(from, pending.top), Math.min(to, pending.bottom));
    }
    pending = stripe;
    if (last) { restoreStripe(stripe, Math.max(from, top), Math.min(to, bottom)); pending = null; }
  }

  function bandEdges() {
    const rows = (a, b) => [0, 1, 2].map(c => {
      const out = new Float32Array(Math.max(0, b - a) * width);
      for (const kept of band.kept) for (let y = Math.max(a, kept.top); y < Math.min(b, kept.top + kept.planes[c].length / width); y++)
        out.set(kept.planes[c].subarray((y - kept.top) * width, (y - kept.top + 1) * width), (y - a) * width);
      return out;
    });
    return {above: rows(band.top, Math.min(band.bottom, band.top + radius)), below: rows(Math.max(band.top, band.bottom - radius), band.bottom)};
  }
  function finishBand(above, below) {
    check(rendered === band.end, 'Incomplete JPEG XL band.');
    const ranges = [];
    if (band.deferTop > band.top) ranges.push([band.top, band.deferTop]);
    if (band.bottom > band.deferBottom) ranges.push([band.deferBottom, band.bottom]);
    if (ranges.length === 2 && ranges[1][0] <= ranges[0][1]) ranges.splice(0, 2, [band.top, band.bottom]);
    const sources = [...band.kept];
    if (above) sources.push({top: band.top - above[0].length / width, planes: above});
    if (below) sources.push({top: band.bottom, planes: below});
    for (const [a, b] of ranges) {
      const lo = Math.max(0, a - radius), hi = Math.min(height, b + radius), stripe = {lo, planes: [0, 1, 2].map(() => new Float32Array((hi - lo) * width))};
      for (const source of sources) for (let c = 0; c < 3; c++) {
        const rows = source.planes[c].length / width;
        for (let y = Math.max(lo, source.top); y < Math.min(hi, source.top + rows); y++)
          stripe.planes[c].set(source.planes[c].subarray((y - source.top) * width, (y - source.top + 1) * width), (y - lo) * width);
      }
      restoreStripe(stripe, a, b);
    }
    band.kept = null;
  }

  function render({lfReference} = {}) {
    check(decodedLF.every(Boolean) && passes && decodedPass.every(p => p.every(Boolean)), 'Incomplete JPEG XL VarDCT frame.');
    while (rendered < groupsY) renderRow(rendered, lfReference);
    const {planes, widths, heights, tightSigma} = prepared;
    return {planes, widths, heights, hshift, vshift, filterSigma: tightSigma, filtersApplied: streams};
  }
  return Object.assign(state, {readLF, readHFGlobal, readPassGroup, renderRow, render, bandEdges, finishBand, band});
}
