// SPDX-License-Identifier: MIT
import {requireDecode as check, unpackSigned as signed} from './decode-bits.mjs';
import {readEntropy, readContextMap, readPermutation, modelSizes, writeModel, writeBlock, syncStream, STREAM_BLOCK_BYTES, HISTORY_BYTES} from './decode-entropy.mjs';
import {decodeModularStream} from './decode-modular.mjs';
import {ceilLog2, COEFF_NUM_NONZERO_CONTEXT, COEFF_FREQ_CONTEXT} from './decode-tables.mjs';
import {TRANSFORMS, naturalOrder, prepareQuantParams, basis, basisT, llfDivisors} from './decode-strategies.mjs';
import {decodeKernels, streamKernels} from './decode-kernels.mjs';
import {restoreFilters, restoreRows, restorationStages, scaledBasis, inverseBlock} from './decode-vardct-transform.mjs';

export {restoreFilters};

const WIRE_ORDER = [1, 0, 2], LF_ORDER = [0, 2, 1];
const ORDER_IDS = [0, 1, 1, 1, 2, 3, 4, 4, 5, 5, 6, 6, 1, 1, 1, 1, 1, 1, 7, 8, 8, 9, 10, 10, 11, 12, 12];
const FAMILY_IDS = [0, 1, 2, 3, 4, 5, 7, 9, 11, 12, 14, 18, 20, 21, 23, 24, 26];
const ORDER_SHAPES = [[1, 1], [1, 1], [2, 2], [4, 4], [2, 1], [4, 1], [4, 2], [8, 8], [8, 4], [16, 16], [16, 8], [32, 32], [32, 16]];
const DEFAULT_BIAS = [1 - .05465007330715401, 1 - .07005449891748593, 1 - .049935103337343655];

export function varDCTArenaCapacity(blocksH) {
  check(Number.isSafeInteger(blocksH) && blocksH > 0, 'Invalid JPEG XL block height.');
  return 3 * 32 * Math.min(32, blocksH) * 64;
}

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
  const groupArenaLength = varDCTArenaCapacity(blocksH);
  const dc = [new Int32Array(dcWidth[0] * dcHeight[0]), new Int32Array(dcWidth[1] * dcHeight[1]), new Int32Array(dcWidth[2] * dcHeight[2])];
  const low = [new Float32Array(dc[0].length), new Float32Array(dc[1].length), new Float32Array(dc[2].length)];
  const metadata = new Array(numLFGroups), blockGroups = Array.from({length: numGroups}, () => []);
  const decodedLF = new Uint8Array(numLFGroups), decodedPass = [];
  const sigma = new Float32Array(blocksW * blocksH);
  const state = {width, height, header, global, lfDequant, bitDepth, globalTree, maxModularWork, modularWork, numGroups, numLFGroups, groupsX, groupsY, lfGroupsX, lfGroupsY};
  let matrices = []; matrices = null;
  let passes = []; passes = null;
  let numPresets = 1; numPresets = 0;
  const arenas = new Array(numGroups), freeArenas = [];

  function readLF(r, group, {decodeExtraLF} = {}) {
    check(Number.isInteger(group) && group >= 0 && group < numLFGroups && !decodedLF[group], 'Invalid or repeated JPEG XL LF group.');
    const bx = group % lfGroupsX * 256, by = Math.floor(group / lfGroupsX) * 256;
    const bw = Math.min(256, blocksW - bx), bh = Math.min(256, blocksH - by);
    if (!header.useLFFrame) {
      const precision = r.read(2), order = [1, 0, 2];
      const channels = decodeModularStream(r, order.map(c => ({width: bw >> hshift[c], height: bh >> vshift[c]})), {
        globalTree: state.globalTree, bitDepth, streamIndex: 1 + group, groupDim: 0,
        maxModularWork: state.maxModularWork, modularWork: state.modularWork,
      });
      const kernels = streamKernels();
      for (let channel = 0; channel < 3; channel++) {
        const c = order[channel], data = channels[channel].data, cw = bw >> hshift[c], ch = bh >> vshift[c];
        const scale = Math.fround(lfDequant[c] * (1 << (9 - precision)) / (global.globalScale * global.quantLF));
        const [at] = kernels.reserve([data.length * 4]), scaled = new Float32Array(kernels.buffer, at, data.length);
        new Int32Array(kernels.buffer, at, data.length).set(data);
        kernels.lfScale(data.length, at, scale);
        for (let y = 0; y < ch; y++) {
          const dest = ((by >> vshift[c]) + y) * dcWidth[c] + (bx >> hshift[c]);
          dc[c].set(data.subarray(y * cw, (y + 1) * cw), dest); low[c].set(scaled.subarray(y * cw, (y + 1) * cw), dest);
        }
      }
    }
    decodeExtraLF?.(r, group);
    const count = r.read(ceilLog2(bw * bh)) + 1;
    check(count <= bw * bh, 'JPEG XL transform count exceeds its LF group.');
    const cw = Math.ceil(Math.min(2048, width - bx * 8) / 64), ch = Math.ceil(Math.min(2048, height - by * 8) / 64);
    const values = decodeModularStream(r, [{width: cw, height: ch}, {width: cw, height: ch}, {width: count, height: 2}, {width: bw, height: bh}], {
      globalTree: state.globalTree, bitDepth, streamIndex: 1 + 2 * numLFGroups + group, groupDim: 0,
      maxModularWork: state.maxModularWork, modularWork: state.modularWork,
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
        const block = {id, x: gx, y: gy, bw: w, bh: h, area: Math.imul(w, h), multiplier, coefficients: [null, null, null], arena: null, lfGroup: group};
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
      const used = r.u32([[0, 95], [0, 19], [0, 0], [13, 0]]), orders = ORDER_SHAPES.map(() => [null, null, null]);
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

  let kernelRegions = {}; kernelRegions = null;
  let entropyKernel = {}; entropyKernel = null;
  let kernelWeights = {}; kernelWeights = null;
  let kernelLF = []; kernelLF = null;
  let kernelBlocks = {}; kernelBlocks = null;
  const GROUP_FAULTS = {10: 'Invalid subsampled JPEG XL transform.', 11: 'Invalid JPEG XL block context.', 12: 'Invalid JPEG XL nonzero predictor.',
    13: 'JPEG XL nonzero count exceeds transform.', 14: 'JPEG XL coefficient overflows its range.', 15: 'JPEG XL coefficient count is incomplete.'};
  const ORDER_SIZE = ORDER_SHAPES.reduce((n, [w, h]) => n + 3 * w * h * 64, 0) * 4;
  function reserveKernelMemory() {
    const kernels = decodeKernels();
    const stages = restorationStages(header.filter), slots = Math.max(1, stages.length), restoring = streams && (radius || band), rows = Math.min(height, 256 + 2 * radius), plane = rows * width * 4;
    const colorScratch = Math.min(height, 256) * width * 4;
    const sigmaLength = Math.ceil(width / 8) * Math.ceil(height / 8);
    const models = passes.map(p => p.entropy.model), arenaCount = passes.length === 1 ? groupsX : numGroups;
    const thresholds = global.lfThresholds.flat().length + global.qfThresholds.length;
    const reader = [STREAM_BLOCK_BYTES, maxSection + 16, ...models.flatMap(m => [...modelSizes(m), m.lz ? HISTORY_BYTES : 0]), passes.length * ORDER_SIZE, 1024,
      512, 32 * 32 * 48, 3 * 32 * 4, global.map.length * 4, thresholds * 8 + 64, ...dc.map(d => d.length * 4), arenaCount * groupArenaLength * 4];
    const sizes = [...(restoring ? [...Array(6 + 3 * slots).fill(plane), 21 * width * 8, width * 8, width * 8, sigmaLength * 4, 32, colorScratch] : []), ...reader,
      matrices.reduce((n, m) => n + m.width * m.height * 12, 0),
      65536 + 3 * 1024 * 8, numLFGroups * 8192, ...(!streams || !radius && !band ? [0, 1, 2].map(c => (256 >> vshift[c]) * Math.ceil(width / (1 << hshift[c])) * 4) : [0, 0, 0]),
      ...Array(9).fill(blocksW * blocksH * 4)];
    const at = kernels.reserve(sizes);
    if (restoring) kernelRegions = {at, rows, stages};
    kernelLF = at.slice(-9);
    kernelBlocks = {tables: at.at(-14), cfl: at.at(-13), rowPlanes: at.slice(-12, -9), next: at.at(-14) + 2048, bases: new Map(), maps: new Map()};
    let weightsAt = at.at(-15);
    kernelWeights = {kernels, offsets: matrices.map(m => { const offset = weightsAt; weightsAt += m.width * m.height * 12; return offset; }), loaded: matrices.map(() => false)};
    let k = restoring ? 12 + 3 * slots : 0;
    const i32 = kernels.i32, f64 = kernels.f64, u16 = new Uint16Array(kernels.buffer);
    const block = at[k++], bytes = at[k++];
    const passStreams = models.map(m => ({model: writeModel(kernels, m, at.slice(k, k += 5)), history: at[k++]}));
    const ordersAt = at[k++], contextsAt = at[k++], args = at[k++], blocks = at[k++], nonzero = at[k++], mapAt = at[k++], thresholdsAt = at[k++];
    const dcAt = dc.map(() => at[k++]), arenasAt = at[k++];
    u16.set(COEFF_NUM_NONZERO_CONTEXT, contextsAt / 2); u16.set(COEFF_FREQ_CONTEXT, (contextsAt + 512) / 2);
    i32.set(global.map, mapAt / 4);
    let t = thresholdsAt + 64;
    const lists = global.lfThresholds.flatMap(list => { const address = t; f64.set(list, t / 8); t += list.length * 8; return [list.length, address]; });
    i32.set(lists, thresholdsAt / 4); f64.set(global.qfThresholds, t / 8);
    dc.forEach((d, c) => i32.set(d, dcAt[c] / 4));
    i32.set([0, blocks, 0, 0, 0, 0, global.clusters, 0, global.lfThresholds.reduce((n, l) => n * (l.length + 1), 1), global.qfThresholds.length + 1, mapAt, global.map.length,
      header.useLFFrame ? 1 : 0, thresholdsAt, global.qfThresholds.length, t, args + 112, args + 124, args + 136, args + 148, args + 160, args + 172, args + 184, contextsAt, contextsAt + 512], args / 4);
    i32.set([...dcAt, ...dcWidth, ...hshift, ...vshift, nonzero, nonzero + 128, nonzero + 256], args / 4 + 28);
    entropyKernel = {kernels, block, bytes, streams: passStreams, ordersAt, loaded: passes.map(() => new Uint8Array(39)), args, blocks, nonzero};
    for (let g = 0; g < arenaCount; g++) freeArenas.push(new Int32Array(kernels.buffer, arenasAt + g * groupArenaLength * 4, groupArenaLength));
  }
  function orderAt(pass, orderID, c) {
    const K = entropyKernel, [w, h] = ORDER_SHAPES[orderID], at = K.ordersAt + pass * ORDER_SIZE + (ORDER_SHAPES.slice(0, orderID).reduce((n, [a, b]) => n + 3 * a * b * 64, 0) + c * w * h * 64) * 4;
    if (!K.loaded[pass][orderID * 3 + c]) { new Uint32Array(K.kernels.buffer, at, w * h * 64).set(passes[pass].orders[orderID][c] ?? naturalOrder(w, h)); K.loaded[pass][orderID * 3 + c] = 1; }
    return at;
  }

  function readPassGroup(r, group, pass) {
    check(passes && Number.isInteger(group) && group >= 0 && group < numGroups && Number.isInteger(pass) && pass >= 0 && pass < passes.length && !decodedPass[pass][group], 'Invalid or repeated JPEG XL coefficient group.');
    const groupX = group % groupsX * 32, groupY = Math.floor(group / groupsX) * 32, gbw = Math.min(32, blocksW - groupX);
    const lfg = Math.floor(groupY / 256) * lfGroupsX + Math.floor(groupX / 256);
    check(decodedLF[lfg], 'JPEG XL LF metadata is absent.');
    const preset = r.read(ceilLog2(numPresets)); check(preset < numPresets, 'Invalid JPEG XL HF preset.');
    const code = passes[pass].entropy.start(r), prefix = preset * global.clusters * 495, K = entropyKernel, {kernels} = K, i32 = kernels.i32;
    const shift = header.passes?.shift?.[pass] || 0, meta = metadata[lfg];
    const arena = arenas[group] ??= {data: freeArenas.pop().fill(0), used: 0}, records = [];
    for (const block of blockGroups[group]) {
      const {id, area, multiplier} = block, {width: tw, height: th} = TRANSFORMS[id], orderID = ORDER_IDS[id], addresses = [0, 0, 0];
      let wires = 0;
      for (let wire = 0; wire < 3; wire++) {
        const c = WIRE_ORDER[wire], sx = (block.x - groupX) >> hshift[c], sy = (block.y - groupY) >> vshift[c];
        if (sx * (1 << hshift[c]) !== block.x - groupX || sy * (1 << vshift[c]) !== block.y - groupY) continue;
        if ((hshift[c] || vshift[c]) && !meta.starts[((groupY & 255) + sy) * meta.bw + (groupX & 255) + sx]) continue;
        wires |= 1 << wire;
        if (block.coefficients[c] == null) {
          check(arena.used + tw * th <= arena.data.length, 'JPEG XL group coefficients exceed the group.');
          block.arena = arena.data; block.coefficients[c] = arena.used; arena.used += tw * th;
        }
        addresses[c] = block.arena.byteOffset + block.coefficients[c] * 4;
        orderAt(pass, orderID, c);
      }
      records.push(0, block.x, block.y, block.bw, area, multiplier, wires, tw * th, orderID, ...addresses);
    }
    i32.set(records, K.blocks / 4);
    for (let c = 0; c < 3; c++) i32.fill(0, K.nonzero / 4 + c * 32, K.nonzero / 4 + c * 32 + 32);
    const stream = K.streams[pass], orders = [];
    for (let id = 0; id < 13; id++) for (let c = 0; c < 3; c++) orders.push(K.loaded[pass][id * 3 + c] ? orderAt(pass, id, c) : 0);
    code.begin();
    const block = writeBlock(kernels, code, K.block, K.bytes, stream.model, stream.history);
    i32.set([block, K.blocks, records.length / 12, groupX, groupY, prefix], K.args / 4);
    i32[K.args / 4 + 7] = 1 << shift;
    i32.set([gbw >> hshift[0], gbw >> hshift[1], gbw >> hshift[2]], K.args / 4 + 43);
    i32.set(orders, K.args / 4 + 46);
    const fault = kernels.passGroup(K.args);
    syncStream(kernels, code, block, fault < 10 ? fault : 0);
    if (fault) check(false, GROUP_FAULTS[fault]);
    code.finish(); decodedPass[pass][group] = 1;
  }

  let prepared = {}; prepared = null;
  let rendered = 1; rendered = 0;
  let pending = {}; pending = null;
  const streams = !maxH && !maxV, radius = streams ? restorationStages(header.filter).reduce((n, s) => n + s.radius, 0) : 0;
  function prepare(lfReference) {
    let lf;
    if (header.useLFFrame) {
      check(lfReference?.planes?.length === 3, 'JPEG XL LF reference is absent.');
      lf = lfReference.planes.map((p, c) => {
        const sourceWidth = lfReference.widths?.[c] ?? lfReference.width ?? dcWidth[c];
        const sourceHeight = lfReference.heights?.[c] ?? lfReference.height ?? dcHeight[c];
        check(sourceWidth >= dcWidth[c] && sourceHeight >= dcHeight[c] && p.length >= sourceWidth * sourceHeight, 'JPEG XL LF reference is too small.');
        const values = new Float32Array(decodeKernels().buffer, kernelLF[c], low[c].length);
        for (let y = 0; y < dcHeight[c]; y++) values.set(p.subarray(y * sourceWidth, y * sourceWidth + dcWidth[c]), y * dcWidth[c]);
        return values;
      });
    } else {
      const kernels = decodeKernels(), planes = from => [0, 1, 2].map(c => new Float32Array(kernels.buffer, kernelLF[from + c], low[c].length));
      lf = planes(0); for (let c = 0; c < 3; c++) lf[c].set(low[c]);
      const smooth = !header.skipAdaptiveLFSmoothing && !dcWidth.some(w => w <= 2) && !dcHeight.some(h => h <= 2);
      const corr = global.correlation, steps = lfDequant.map(m => 512 * m / (global.globalScale * global.quantLF));
      kernels.i32.set([...kernelLF, ...dcWidth, ...dcHeight, ...hshift, ...vshift], kernels.args / 4);
      kernels.lfPrepare(kernels.args, !maxH && !maxV ? 1 : 0, corr.baseX + (corr.lfX - 128) / corr.factor, corr.baseB + (corr.lfB - 128) / corr.factor, smooth ? 1 : 0, ...steps);
      if (smooth) lf = planes(6);
    }
    const widths = hshift.map(s => Math.ceil(width / (1 << s))), heights = vshift.map(s => Math.ceil(height / (1 << s)));
    const cellsW = Math.ceil(width / 8), cellsH = Math.ceil(height / 8), tightSigma = blocksW === cellsW ? sigma : new Float32Array(cellsW * cellsH);
    if (tightSigma !== sigma) for (let y = 0; y < cellsH; y++) tightSigma.set(sigma.subarray(y * blocksW, y * blocksW + cellsW), y * cellsW);
    prepared = {lf, widths, heights, tightSigma,
      planes: band ? null : widths.map((w, c) => new Float32Array(w * heights[c])),
      bias: imageHeader.opsinInverseMatrix?.quantBias || DEFAULT_BIAS, numerator: imageHeader.opsinInverseMatrix?.quantBiasNumerator ?? .145,
      qmScale: [header.xQmScale ?? 3, 2, header.bQmScale ?? 2].map(s => { let v = 1; for (let i = 2; i < s; i++) v *= .8; for (let i = s; i < 2; i++) v /= .8; return v; }),
      scratch: decodeKernels().coefficients, restoration: [], stripes: null, blockPlanes: [null, null, null]};
    if (streams && (radius || band)) {
      const rows = Math.min(height, 256 + 2 * radius), plane = rows * width * 4, stages = restorationStages(header.filter), kernels = decodeKernels();
      if (kernelRegions) {
        const {at} = kernelRegions;
        const planes = from => [0, 1, 2].map(c => new Float32Array(kernels.buffer, at[from + c], rows * width));
        prepared.stripes = [planes(0), planes(3)];
        for (let i = 0; i < stages.length - 1; i++) prepared.restoration[i] = planes(6 + 3 * i);
        const k = 6 + 3 * Math.max(1, stages.length);
        prepared.restoration.kernel = {final: planes(k - 3), ring: at[k], up: at[k + 1], down: at[k + 2], sigma: at[k + 3], args: at[k + 4], rgba: at[k + 5],
          rgbaBytes: Math.min(height, 256) * width * 4};
        if (band) band.kernel = prepared.restoration.kernel;
        new Float32Array(kernels.buffer, at[k + 3], prepared.tightSigma.length).set(prepared.tightSigma);
      }
    }
    return prepared;
  }

  function blockTable(key, values) {
    const K = kernelBlocks;
    let at = K.bases.get(key);
    if (at === undefined) {
      const v = values(); at = K.next; K.next += v.byteLength;
      check(K.next <= K.tables + 65536, 'JPEG XL block tables exceed their region.');
      K.bases.set(key, at); new v.constructor(decodeKernels().buffer, at, v.length).set(v);
    }
    return at;
  }
  function cflMaps(lfGroup) {
    const K = kernelBlocks, group = metadata[lfGroup];
    if (!K.maps.has(lfGroup)) { const at = K.cfl + lfGroup * 8192, i32 = decodeKernels().i32; i32.set(group.xFromY, at / 4); i32.set(group.bFromY, at / 4 + 1024); K.maps.set(lfGroup, at); }
    return K.maps.get(lfGroup);
  }
  function renderBlock(block, targets, tops) {
    const P = prepared, {lf, widths, heights, bias, numerator, qmScale} = P, group = metadata[block.lfGroup], kernels = decodeKernels();
    const {id, area, multiplier, bw, bh} = block, shape = TRANSFORMS[id], size = area * 64, quant = expandMatrix(matrices[shape.table]);
    const transpose = !(id === 1 || id === 2 || id === 3 || id >= 12 && id <= 17) && shape.height >= shape.width;
    const cflBlock = !maxH && !maxV, held = block.coefficients, K = kernelWeights, arena = block.arena.byteOffset, table = shape.table;
    if (id === 0 && cflBlock && held.every(h => typeof h === 'number')) {
      const {offsets, loaded} = K, scale = 65536 / (global.globalScale * multiplier);
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
    const wide = Math.max(shape.width, shape.height), coefficients = P.blockPlanes, i32 = kernels.i32, tiles = kernelBlocks.tables;
    coefficients[0] = coefficients[1] = coefficients[2] = null;
    if (cflBlock) {
      const columns = size / wide;
      for (let u = 0; u < wide; u++) { const px = block.x * 8 + (transpose ? 0 : u), py = block.y * 8 + (transpose ? u : 0); i32[tiles / 4 + u] = transpose ? Math.floor(py / 64) - (group.by >> 3) : Math.floor(px / 64) - (group.bx >> 3); }
      for (let v = 0; v < columns; v++) { const px = block.x * 8 + (transpose ? v : 0), py = block.y * 8 + (transpose ? 0 : v); i32[tiles / 4 + 256 + v] = transpose ? Math.floor(px / 64) - (group.bx >> 3) : Math.floor(py / 64) - (group.by >> 3); }
    }
    for (let wire = 0; wire < 3; wire++) {
      const c = WIRE_ORDER[wire], h = held[c]; if (h == null) continue;
      const values = P.scratch[c], factor = 65536 / (global.globalScale * multiplier) * qmScale[c];
      if (!K.loaded[table]) { for (let k = 0; k < 3; k++) new Float32Array(kernels.buffer, K.offsets[table] + k * size * 4, size).set(quant[k]); K.loaded[table] = true; }
      kernels.dequant(arena + h * 4, size, K.offsets[table] + c * size * 4, factor, bias[c], numerator, values.byteOffset);
      if (c !== 1 && cflBlock) {
        const maps = cflMaps(block.lfGroup), base = c === 0 ? global.correlation.baseX : global.correlation.baseB, map = c === 0 ? maps : maps + 4096, luma = coefficients[1];
        if (size === 64) {
          const ci = transpose ? i32[tiles / 4] * group.width + i32[tiles / 4 + 256] : i32[tiles / 4 + 256] * group.width + i32[tiles / 4];
          kernels.cfl64(values.byteOffset, luma.byteOffset, base + i32[map / 4 + ci] / global.correlation.factor);
        } else kernels.cfl(values.byteOffset, luma.byteOffset, size, wide, tiles, tiles + 1024, transpose ? 1 : 0, group.width, map, base, global.correlation.factor);
      }
      const bx = block.x >> hshift[c], by = block.y >> vshift[c], plane = lf[c], stride = dcWidth[c];
      if (area === 1) values[0] = 0 + plane[by * stride + bx];
      else {
        const w = Math.max(bw, bh), h2 = Math.min(bw, bh);
        i32.set([values.byteOffset, plane.byteOffset, stride, bx, by, bw, bh, blockTable('T' + bw, () => basisT(bw)), blockTable('B' + bh, () => basis(bh)),
          blockTable('D' + w + 'x' + h2, () => llfDivisors(w, h2)), wide, kernelBlocks.tables + 65536], kernels.args / 4);
        kernels.llf(kernels.args);
      }
      coefficients[c] = values;
    }
    block.coefficients = block.arena = null;
    for (let c = 0; c < 3; c++) if (coefficients[c]) {
      const values = coefficients[c], x0 = (block.x >> hshift[c]) * 8, y0 = (block.y >> vshift[c]) * 8;
      inverseBlock(kernels, values.byteOffset, shape);
      const w = widths[c], xs = Math.min(shape.width, w - x0), ys = Math.min(shape.height, heights[c] - y0);
      if (xs > 0 && ys > 0) kernels.store(shape.width, targets[c], (y0 - tops[c]) * w + x0, w, xs, ys);
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
    if (!streams || !radius && !band) {
      const buffer = decodeKernels().buffer, tops = [0, 1, 2].map(c => (k * 256) >> vshift[c]);
      const rowPlanes = [0, 1, 2].map(c => new Float32Array(buffer, kernelBlocks.rowPlanes[c], (256 >> vshift[c]) * P.widths[c]));
      for (const block of blocks) renderBlock(block, rowPlanes, tops);
      release();
      for (let c = 0; c < 3; c++) {
        const rows = Math.max(0, Math.min(P.heights[c], tops[c] + (256 >> vshift[c])) - tops[c]);
        P.planes[c].set(rowPlanes[c].subarray(0, rows * P.widths[c]), tops[c] * P.widths[c]);
      }
      return;
    }
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
      const lo = Math.max(0, a - radius), hi = Math.min(height, b + radius), stripe = {lo, planes: prepared.stripes[0].map(p => p.subarray(0, (hi - lo) * width))};
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
