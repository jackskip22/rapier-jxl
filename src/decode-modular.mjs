// SPDX-License-Identifier: MIT
import {readEntropy, readHybridUint, readPrefixSymbol} from './decode-entropy.mjs';
import {requireDecode, unpackSigned} from './decode-bits.mjs';
import {DEFAULT_WEIGHTED, RECIPROCAL, weightedDivision} from './decode-modular-weights.mjs';
import {part} from './decode-parts.mjs';

const POWERS = [1]; for (let i = 1; i <= 32; i++) POWERS.push(POWERS[i - 1] * 2);
const DEFAULT_MAX_SAMPLES = 134217728;
const DEFAULT_MAX_WORK = 536870912;
const EMPTY_I32 = new Int32Array(0);
function emptyRefList() {
  const a = [EMPTY_I32];
  a.length = 0;
  return a;
}
function workLimit(modularWork, remaining) {
  modularWork.remaining = remaining;
  throw Object.assign(new RangeError('JPEG XL Modular work exceeds the limit.'), {code: 'JXL_LIMIT'});
}

export function readMATree(r, {maxNodes = 1048576, maxDepth = 2048} = {}) {
  requireDecode(Number.isSafeInteger(maxNodes) && maxNodes > 0 && maxNodes <= 1048576, 'Invalid MA tree bound.', r);
  const coding = readEntropy(r, 6, {values: maxNodes * 5, distanceMultiplier: 0});
  const nodes = [{depth: 0}];
  let leaves = 0, weighted = false;
  for (let i = 0; i < nodes.length; i++) {
    requireDecode(nodes.length <= maxNodes && nodes[i].depth <= maxDepth, 'JPEG XL MA tree exceeds its bound.', r);
    const node = nodes[i], property = coding.read(1);
    if (property) {
      node.property = property - 1; node.value = unpackSigned(coding.read(0));
      requireDecode(node.property <= 0xffffffff, 'Invalid MA property.', r);
      node.left = nodes.length; node.right = nodes.length + 1;
      nodes.push({depth: node.depth + 1}, {depth: node.depth + 1});
      weighted ||= node.property === 15;
    } else {
      node.property = -1; node.context = leaves++; node.predictor = coding.read(2);
      node.offset = unpackSigned(coding.read(3));
      const exponent = coding.read(4), mantissa = coding.read(5);
      requireDecode(node.predictor <= 13 && exponent <= 30 && mantissa <= POWERS[31 - exponent] - 2, 'Invalid MA leaf.', r);
      node.multiplier = (mantissa + 1) * POWERS[exponent];
      weighted ||= node.predictor === 6;
    }
  }
  coding.finish();
  const entropy = readEntropy(r, leaves);
  return {nodes, entropy, weighted, leaves};
}

function channelSamples(channels, maximum) {
  let total = 0;
  for (const c of channels) {
    requireDecode(Number.isSafeInteger(c.width) && Number.isSafeInteger(c.height) && c.width >= 0 && c.height >= 0 &&
      Number.isInteger(c.hshift) && Number.isInteger(c.vshift) && c.hshift >= -1 && c.vshift >= -1 && c.hshift <= 31 && c.vshift <= 31,
      'Invalid Modular channel dimensions.');
    const samples = c.width * c.height;
    if (!Number.isSafeInteger(samples) || samples > maximum - total) throw Object.assign(new RangeError('JPEG XL Modular samples exceed the memory limit.'), {code: 'JXL_MEMORY'});
    total += samples;
  }
  return total;
}

export function localTree(nodes) {
  const n = nodes.length, property = new Int32Array(n), value = new Int32Array(n), left = new Int32Array(n), right = new Int32Array(n);
  const context = new Int32Array(n), predictor = new Int32Array(n), offset = new Int32Array(n), multiplier = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const node = nodes[i], prop = node.property;
    property[i] = prop > 0x3fffffff ? 0x3fffffff : prop;
    if (prop >= 0) { value[i] = node.value; left[i] = node.left; right[i] = node.right; }
    else { context[i] = node.context; predictor[i] = node.predictor; offset[i] = node.offset; multiplier[i] = node.multiplier; }
  }
  return {property, value, left, right, context, predictor, offset, multiplier, tables: new Map(), references: nodes.some(node => node.property >= 16)};
}

function propertyTable(tree, root, samples) {
  const {property, value, left, right} = tree, thresholds = [], stack = [root];
  let tested = -1;
  while (stack.length) {
    const node = stack.pop();
    if (property[node] < 0) continue;
    if (tested >= 0 && property[node] !== tested || !Number.isInteger(value[node]) || Math.abs(value[node]) > 1073741824 || thresholds.length === 256) return null;
    tested = property[node]; thresholds.push(value[node]); stack.push(left[node], right[node]);
  }
  if (tested < 0) return null;
  const low = Math.min(...thresholds), size = Math.max(...thresholds) - low + 2;
  if (size > 4096 || size > samples) return null;
  const leaf = new Int32Array(size), depth = new Int32Array(size);
  for (let k = 0; k < size; k++) {
    let node = root, steps = 0;
    while (property[node] >= 0) { steps++; node = low + k > value[node] ? left[node] : right[node]; }
    leaf[k] = node; depth[k] = steps;
  }
  return {tested, low, high: low + size - 1, leaf, depth};
}

function decodeConstantLeaf(d, width, height, ctx, pred, off, mul, entropy) {
  const total = width * height;
  if (pred === 0) {
    const m = entropy.model;
    if (m && m.lz && m.prefix && !entropy.finished && ctx >= 0 && ctx < m.contexts && entropy.remaining >= total) {
      const r = entropy.reader, cluster = m.map[ctx], code = m.codes[cluster], cfg = m.configs[cluster];
      const fastLimit = cfg.fastLimit, splitToken = cfg.splitToken, minimum = m.minimum;
      const history = entropy.history, mask = 1048575, distMul = entropy.distanceMultiplier;
      for (let i = 0; i < total;) {
        if (entropy.left > 0) {
          const run = entropy.left < total - i ? entropy.left : total - i;
          let pos = entropy.position;
          const dist = entropy.distance;
          entropy.left -= run;
          entropy.remaining -= run;
          for (let k = 0; k < run; k++, i++, pos++) {
            const v = history[(pos - dist) & mask];
            history[pos & mask] = v;
            d[i] = (off + Math.imul((v >>> 1) ^ -(v & 1), mul)) | 0;
          }
          entropy.position = pos;
          continue;
        }
        const token = readPrefixSymbol(r, code);
        entropy.remaining--;
        let v;
        if (token < fastLimit) {
          v = token;
        } else if (token >= minimum) {
          v = entropy.lzRun(r, m, token, distMul);
        } else {
          v = token < splitToken ? token : readHybridUint(r, token, cfg);
        }
        const pos = entropy.position;
        history[pos & mask] = v;
        entropy.position = pos + 1;
        d[i++] = (off + Math.imul((v >>> 1) ^ -(v & 1), mul)) | 0;
      }
      return true;
    }
    for (let i = 0; i < total;) {
      if (entropy.left > 0 && entropy.remaining >= entropy.left) {
        const run = entropy.left < total - i ? entropy.left : total - i;
        const history = entropy.history, dist = entropy.distance, mask = 1048575;
        let pos = entropy.position;
        entropy.left -= run;
        entropy.remaining -= run;
        for (let k = 0; k < run; k++, i++, pos++) {
          const v = history[(pos - dist) & mask];
          history[pos & mask] = v;
          d[i] = (off + Math.imul((v >>> 1) ^ -(v & 1), mul)) | 0;
        }
        entropy.position = pos;
      } else {
        const v = entropy.read(ctx);
        d[i++] = (off + Math.imul((v >>> 1) ^ -(v & 1), mul)) | 0;
      }
    }
    return true;
  }
  if (pred === 1 || pred === 2 || pred === 5) {
    let i = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++, i++) {
        const w = x ? d[i - 1] : y ? d[i - width] : 0;
        const n = y ? d[i - width] : w;
        const nw = x && y ? d[i - width - 1] : w;
        let guess;
        if (pred === 1) guess = w;
        else if (pred === 2) guess = n;
        else {
          const lo = w < n ? w : n, hi = w > n ? w : n, g = w + n - nw;
          guess = g < lo ? lo : g > hi ? hi : g;
        }
        const v = entropy.read(ctx);
        d[i] = (guess + off + Math.imul((v >>> 1) ^ -(v & 1), mul)) | 0;
      }
    }
    return true;
  }
  return false;
}

function predictSample(pred, w, n, nw, ne, nn, ww, gradient, weightedPrediction, d, i, x, y, width) {
  switch (pred) {
    case 0: return 0;
    case 1: return w;
    case 2: return n;
    case 3: return Math.trunc((w + n) * .5) | 0;
    case 4: return Math.abs(n - nw) < Math.abs(w - nw) ? w : n;
    case 5: { const lo = w < n ? w : n, hi = w > n ? w : n; return gradient < lo ? lo : gradient > hi ? hi : gradient; }
    case 6: return Math.floor((weightedPrediction + 3) * .125) | 0;
    case 7: return ne;
    case 8: return nw;
    case 9: return ww;
    case 10: return Math.trunc((w + nw) * .5) | 0;
    case 11: return Math.trunc((n + nw) * .5) | 0;
    case 12: return Math.trunc((n + ne) * .5) | 0;
    default: { const nee = y && x + 2 < width ? d[i - width + 2] : ne; return Math.trunc((6 * n - 2 * nn + 7 * w + ww + nee + 3 * ne + 8) * .0625) | 0; }
  }
}

export function decodeLocal(channel, tree, root, parameters, channelIndex, streamIndex, entropy, remaining, modularWork, references = []) {
  const refs = references.length && !(references[0] instanceof Int32Array) ? references.map(c => c.data) : references;
  return decodeLocalData(channel.data, channel.width | 0, channel.height | 0, tree, root, parameters, channelIndex, streamIndex, entropy, remaining, modularWork, refs);
}

function decodeLocalData(d, width, height, tree, root, parameters, channelIndex, streamIndex, entropy, remaining, modularWork, references) {
  const {property, value, left, right, context, predictor, offset, multiplier} = tree;
  if (property[root] < 0 && !parameters && decodeConstantLeaf(d, width, height, context[root], predictor[root], offset[root], multiplier[root], entropy)) {
    return remaining;
  }
  const hasWP = parameters !== null, stride = width + 2;
  const error = new Int32Array(hasWP ? stride * 2 : 0);
  const sub0 = new Uint32Array(hasWP ? stride * 2 : 0), sub1 = new Uint32Array(hasWP ? stride * 2 : 0);
  const sub2 = new Uint32Array(hasWP ? stride * 2 : 0), sub3 = new Uint32Array(hasWP ? stride * 2 : 0);
  const p = parameters ?? DEFAULT_WEIGHTED;
  const p0 = p[0], p1 = p[1], p2 = p[2], p3 = p[3], p4 = p[4], p5 = p[5], p6 = p[6], p7 = p[7], p8 = p[8], p9 = p[9], p10 = p[10];
  const refCache = new Float64Array([-1, -1, 0, 0]);
  let i = 0;
  for (let y = 0; y < height; y++) {
    let previousGradient = 0;
    const current = y & 1 ? 0 : stride, previous = y & 1 ? stride : 0;
    for (let x = 0; x < width; x++, i++) {
      const w = x ? d[i - 1] : y ? d[i - width] : 0;
      const n = y ? d[i - width] : w;
      const nw = x && y ? d[i - width - 1] : w;
      const ne = y && x + 1 < width ? d[i - width + 1] : n;
      const nn = y > 1 ? d[i - width * 2] : n;
      const ww = x > 1 ? d[i - 2] : w;
      let a0 = 0, a1 = 0, a2 = 0, a3 = 0, weightedPrediction = 0, maximumError = 0;
      if (hasWP) {
        const north = previous + x, northEast = x + 1 < width ? north + 1 : north, northWest = x ? north - 1 : north;
        const eN = error[north], eW = x ? error[current + x - 1] : 0, eNW = error[northWest], eNE = error[northEast];
        a0 = (w + ne - n) * 8;
        a1 = n * 8 - Math.floor((eN + eW + eNE) * p0 * .03125);
        a2 = w * 8 - Math.floor((eN + eW + eNW) * p1 * .03125);
        a3 = n * 8 - Math.floor((eNW * p2 + eN * p3 + eNE * p4 + (nn - n) * 8 * p5 + (nw - w) * 8 * p6) * .03125);
        let w0 = weight(sub0, north, northEast, northWest, p7), w1 = weight(sub1, north, northEast, northWest, p8);
        let w2 = weight(sub2, north, northEast, northWest, p9), w3 = weight(sub3, north, northEast, northWest, p10);
        const shift = 27 - Math.clz32(w0 + w1 + w2 + w3);
        w0 >>>= shift; w1 >>>= shift; w2 >>>= shift; w3 >>>= shift;
        const total = w0 + w1 + w2 + w3;
        let sum = (total >> 1) - 1;
        sum += a0 * w0; sum += a1 * w1; sum += a2 * w2; sum += a3 * w3;
        weightedPrediction = weightedDivision(sum, RECIPROCAL[total]);
        if (((eN ^ eW) | (eN ^ eNW)) <= 0) {
          const minNW = n < w ? n : w, maxNW = n > w ? n : w;
          const lo = (ne < minNW ? ne : minNW) * 8, hi = (ne > maxNW ? ne : maxNW) * 8;
          if (weightedPrediction < lo) weightedPrediction = lo;
          else if (weightedPrediction > hi) weightedPrediction = hi;
        }
        const aW = Math.abs(eW), aN = Math.abs(eN), aNW = Math.abs(eNW), aNE = Math.abs(eNE);
        maximumError = eW; let maxAbs = aW;
        if (aN > maxAbs) { maximumError = eN; maxAbs = aN; }
        if (aNW > maxAbs) { maximumError = eNW; maxAbs = aNW; }
        if (aNE > maxAbs) maximumError = eNE;
      }
      const gradient = w + n - nw;
      let node = root;
      while (property[node] >= 0) {
        if (--remaining < 0) workLimit(modularWork, remaining);
        const v = evalProperty(property[node], channelIndex, streamIndex, y, x, n, w, nw, ne, nn, ww, previousGradient, gradient, maximumError, references, i, width, refCache);
        node = v > value[node] ? left[node] : right[node];
      }
      const raw = entropy.read(context[node]), residual = (raw >>> 1) ^ -(raw & 1);
      const guess = predictSample(predictor[node], w, n, nw, ne, nn, ww, gradient, weightedPrediction, d, i, x, y, width);
      const sample = (guess + offset[node] + Math.imul(residual, multiplier[node])) | 0;
      d[i] = sample;
      if (hasWP) {
        const v = sample * 8, at = current + x, east = previous + x + 1;
        error[at] = (weightedPrediction - v) | 0;
        let e = Math.floor((Math.abs(a0 - v) + 3) * .125); sub0[at] = e; sub0[east] += e;
        e = Math.floor((Math.abs(a1 - v) + 3) * .125); sub1[at] = e; sub1[east] += e;
        e = Math.floor((Math.abs(a2 - v) + 3) * .125); sub2[at] = e; sub2[east] += e;
        e = Math.floor((Math.abs(a3 - v) + 3) * .125); sub3[at] = e; sub3[east] += e;
      }
      previousGradient = gradient | 0;
    }
  }
  return remaining;
}

function evalProperty(id, channelIndex, streamIndex, y, x, n, w, nw, ne, nn, ww, previousGradient, gradient, maximumError, references, i, width, refCache) {
  if (id >= 16) return ((id - 16) >> 2) < references.length ? referenceProperty(id, references, i, x, y, width, refCache) : 0;
  switch (id) {
    case 0: return channelIndex; case 1: return streamIndex; case 2: return y; case 3: return x;
    case 4: return Math.abs(n) | 0; case 5: return Math.abs(w) | 0; case 6: return n; case 7: return w;
    case 8: return (w - previousGradient) | 0; case 9: return gradient | 0; case 10: return (w - nw) | 0;
    case 11: return (nw - n) | 0; case 12: return (n - ne) | 0; case 13: return (n - nn) | 0; case 14: return (w - ww) | 0;
    default: return maximumError | 0;
  }
}

function referenceProperty(id, references, i, x, y, width, refCache) {
  const offset = id - 16, idx = offset >> 2, data = references[references.length - 1 - idx], value = data[i], kind = offset & 3;
  if (kind === 0) return Math.abs(value) | 0;
  if (kind === 1) return value;
  let difference;
  if (idx < 2 && refCache[idx] === i) {
    difference = refCache[idx + 2];
  } else {
    const left = x ? data[i - 1] : y ? data[i - width] : 0, top = y ? data[i - width] : left;
    const corner = x && y ? data[i - width - 1] : left;
    const lo = left < top ? left : top, hi = left > top ? left : top, g = left + top - corner;
    difference = value - (g < lo ? lo : g > hi ? hi : g);
    if (idx < 2) { refCache[idx] = i; refCache[idx + 2] = difference; }
  }
  return kind === 2 ? Math.abs(difference) | 0 : difference | 0;
}

{
  localTree([{property: -1, context: 0, predictor: 0, offset: 0, multiplier: 1}]); localTree([]);
  const warmRefs = emptyRefList(), warmData = new Int32Array([10, -20, 30, -40, 50, -60, 70, -80]), warmCache = new Float64Array([-1, -1, 0, 0]);
  for (let rep = 0; rep < 16; rep++) {
    warmRefs.length = 0;
    for (let p = 0; p < 24; p++) evalProperty(p, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, warmRefs, 0, 4, warmCache);
    warmRefs.push(warmData, warmData);
    for (const [y, x, i] of [[1, 1, 5], [0, 1, 1], [1, 0, 4], [0, 0, 0]]) {
      for (let pass = 0; pass < 2; pass++) for (let p = 0; p < 24; p++) {
        evalProperty(p, 0, 0, y, x, -1, 1, 0, 0, 0, 0, 0, 0, 0, warmRefs, i, 4, warmCache);
      }
    }
    for (let p = 0; p < 14; p++) {
      predictSample(p, -1, 0, 0, 0, 0, 0, 0, -5, warmData, 4, 0, 1, 4);
      predictSample(p, 1, -1, 0, 0, 0, 0, 0, 5, warmData, 2, 0, 0, 2);
    }
  }
}

function weight(errors, north, northEast, northWest, parameter) {
  const sum = (errors[north] + errors[northEast] + errors[northWest]) >>> 0;
  if (sum < 63) return (4 + Math.imul(parameter, RECIPROCAL[sum + 1])) >>> 0;
  if (sum <= 0x7ffffffe) { const shift = 26 - Math.clz32(sum + 1); return (4 + (Math.imul(parameter, RECIPROCAL[(sum >>> shift) + 1]) >>> shift)) >>> 0; }
  let scale = 1, size = sum + 1;
  while (size >= 64) { size = Math.floor(size / 2); scale *= 2; }
  return (4 + Math.floor(parameter * RECIPROCAL[Math.floor(sum / scale) + 1] / scale)) >>> 0;
}

const LOCAL_FAULTS = ['', 'Invalid JPEG XL entropy read.', 'Truncated JPEG XL data.', 'JPEG XL integer exceeds 32 bits.'];
function kernelChannels(kernels, entropy, tree, channels, remaining, streamIndex) {
  const m = entropy.model, r = entropy.reader;
  if (r.bytes.length > 0x0fffffff || r.bit > 0x7fffffff) return null;
  if (m.lz || m.prefix || m.codes.some(c => c.counts.length > 256) || tree.local.references || !channels.length) return null;
  if (![remaining, entropy.remaining, streamIndex, channels.length].every(n => Number.isInteger(n) && n >= 0 && n <= 0x7fffffff) ||
      r.bytes.length >= 0x08000000 || !Number.isInteger(r.bit) || r.bit < 0 || r.bit > r.bytes.length * 8) return null;
  let area = 0, stride = 2;
  for (const c of channels) { area = Math.max(area, c.width * c.height); stride = Math.max(stride, c.width + 2); }
  const nodes = tree.local.property.length;
  const sizes = [area * 4, nodes * 32, 4096 * 8, 44, 5 * stride * 8, r.bytes.length + 16, m.map.length, m.codes.length * 12816, 65 * 4, 128];
  let end = kernels.arena;
  for (const size of sizes) {
    if (!Number.isSafeInteger(size) || size < 0) return null;
    end += Math.ceil(size / 16) * 16;
    if (end > 0x80000000) return null;
  }
  const [samples, nodeAt, leafAt, parametersAt, weightedAt, bytesAt, mapAt, tablesAt, reciprocalsAt, io] =
    kernels.reserve(sizes);
  const u8 = new Uint8Array(kernels.buffer), u16 = new Uint16Array(kernels.buffer), i32 = new Int32Array(kernels.buffer);
  u8.set(r.bytes, bytesAt); u8.fill(0, bytesAt + r.bytes.length, bytesAt + r.bytes.length + 16); u8.set(m.map, mapAt);
  m.codes.forEach((code, c) => {
    const t = tablesAt + c * 12816, config = m.configs[c];
    u8.set(code.symbols, t); u16.set(code.offsets, (t + 4096) / 2); u16.set(code.counts, (t + 12288) / 2);
    u8[t + 12800] = config.split; u8[t + 12801] = config.msb; u8[t + 12802] = config.lsb;
  });
  const {property, value, left, right, context, predictor, offset, multiplier} = tree.local;
  for (let k = 0, at = nodeAt / 4; k < nodes; k++, at += 8) {
    i32[at] = property[k]; i32[at + 1] = value[k]; i32[at + 2] = left[k]; i32[at + 3] = right[k];
    i32[at + 4] = context[k]; i32[at + 5] = predictor[k]; i32[at + 6] = offset[k]; i32[at + 7] = multiplier[k];
  }
  new Uint32Array(kernels.buffer, reciprocalsAt, 65).set(RECIPROCAL);
  return {kernels, i32, samples, nodeAt, leafAt, parametersAt, weightedAt, bytesAt, mapAt, tablesAt, reciprocalsAt, io, stride};
}
function kernelLocal(K, channel, tree, root, parameters, channelIndex, streamIndex, entropy, remaining, modularWork) {
  const {kernels, i32} = K, width = channel.width, height = channel.height, r = entropy.reader, m = entropy.model;
  const table = tree.local.tables.get(root) ?? propertyTable(tree.local, root, width * height);
  if (table) { tree.local.tables.set(root, table); i32.set(table.leaf, K.leafAt / 4); i32.set(table.depth, K.leafAt / 4 + 4096); }
  if (parameters) i32.set(parameters, K.parametersAt / 4);
  i32.fill(0, K.weightedAt / 4, K.weightedAt / 4 + 10 * K.stride);
  const io = i32.subarray(K.io / 4, K.io / 4 + 32), budget = Math.min(entropy.remaining, 0x7fffffff);
  io.set([K.samples, width, height, K.nodeAt, root, table ? K.leafAt : 0, K.leafAt + 4096 * 4, table?.tested ?? 0, table?.low ?? 0, table?.high ?? 0,
    parameters ? K.parametersAt : 0, K.weightedAt, channelIndex, streamIndex, remaining, entropy.state, r.bit, K.bytesAt, r.bytes.length * 8, budget,
    K.mapAt, m.contexts, K.tablesAt, K.reciprocalsAt]);
  const fault = kernels.modular(K.io), used = budget - io[19];
  entropy.remaining -= used; entropy.position += used; entropy.state = io[15] >>> 0; r.bit = io[16];
  if (fault === 5) workLimit(modularWork, -1);
  if (fault) requireDecode(false, LOCAL_FAULTS[fault], r);
  channel.data.set(i32.subarray(K.samples / 4, K.samples / 4 + width * height));
  return io[14];
}

function decodeChannels(r, channels, tree, parameters, streamIndex, modularWork, kernels = null) {
  if (!channels.length) return;
  let values = 0, distanceMultiplier = 0;
  for (const c of channels) { values += c.width * c.height; distanceMultiplier = Math.max(distanceMultiplier, c.width); }
  let remaining = modularWork.remaining - 2 * values;
  modularWork.remaining = remaining;
  if (remaining < 0) workLimit(modularWork, remaining);
  const entropy = tree.entropy.start(r, {values, distanceMultiplier});
  entropy.begin();
  tree.local ??= localTree(tree.nodes);
  const earlier = tree.local.references ? new Map() : null, noReferences = emptyRefList();
  const K = kernels && remaining <= 0x7fffffff && kernelChannels(kernels, entropy, tree, channels, remaining, streamIndex);
  for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
    const channel = channels[channelIndex], count = channel.width * channel.height;
    channel.data = new Int32Array(count); channel.decoded = count;
    if (!count) continue;
    const shape = earlier ? [channel.width, channel.height, channel.hshift, channel.vshift].join(',') : null;
    const previous = earlier ? (earlier.get(shape) ?? emptyRefList()) : noReferences;
    const nodes = tree.nodes;
    let rootIndex = 0;
    while (nodes[rootIndex].property === 0 || nodes[rootIndex].property === 1) {
      if (--remaining < 0) workLimit(modularWork, remaining);
      const root = nodes[rootIndex];
      rootIndex = (root.property === 0 ? channelIndex : streamIndex) > root.value ? root.left : root.right;
    }
    if (K) remaining = kernelLocal(K, channel, tree, rootIndex, tree.weighted ? parameters : null, channelIndex, streamIndex, entropy, remaining, modularWork);
    else remaining = decodeLocalData(channel.data, channel.width | 0, channel.height | 0, tree.local, rootIndex, tree.weighted ? parameters : null, channelIndex, streamIndex, entropy, remaining, modularWork, previous);
    if (earlier) { previous.push(channel.data); earlier.set(shape, previous); }
    modularWork.remaining = remaining;
  }
  entropy.finish();
}

export function createModular(r, inputChannels, options = {}) {
  const {globalTree, groupDim = 256, bitDepth = 8, maxSamples = DEFAULT_MAX_SAMPLES, maxModularWork = DEFAULT_MAX_WORK, kernels = null} = options;
  requireDecode(Number.isSafeInteger(maxSamples) && maxSamples >= 0 && maxSamples <= 2147483647, 'Invalid Modular memory bound.');
  requireDecode(Number.isSafeInteger(maxModularWork) && maxModularWork >= 0, 'Invalid Modular work bound.');
  const modularWork = options.modularWork ?? {remaining: maxModularWork};
  requireDecode(typeof modularWork === 'object' && Number.isSafeInteger(modularWork.remaining) && modularWork.remaining >= 0, 'Invalid shared Modular work budget.');
  requireDecode(Number.isInteger(bitDepth) && bitDepth >= 1 && bitDepth <= 32, 'Invalid Modular bit depth.');
  const channels = inputChannels.map(c => ({width: c.width, height: c.height, hshift: c.hshift ?? 0, vshift: c.vshift ?? 0, data: EMPTY_I32, decoded: 0, regions: null}));
  const size = list => channelSamples(list, maxSamples);
  size(channels);
  let transforms = [], meta = 0, parameters = DEFAULT_WEIGHTED, tree = globalTree;
  if (channels.length) {
    const useGlobal = !!r.read(1);
    if (!r.read(1)) parameters = Array.from({length: 11}, (_, i) => r.read(i < 7 ? 5 : 4));
    const count = r.u32([[0, 0], [0, 1], [4, 2], [8, 18]]);
    const chargeTransform = samples => {
      const remaining = modularWork.remaining - samples;
      if (remaining < 0) workLimit(modularWork, remaining);
      modularWork.remaining = remaining;
    };
    if (count) ({transforms, meta} = part('transforms').readModularTransforms(r, channels, count, parameters, size, chargeTransform));
    if (useGlobal) requireDecode(!!tree, 'JPEG XL Modular stream has no global tree.', r);
    else tree = readMATree(r, {maxNodes: Math.min(1048576, 1024 + size(channels))});
  }
  let globalCount = 0, closed = false;
  const admitOpen = () => requireDecode(!closed, 'Modular image has already been finished.');
  const state = {
    channels, transforms, metaChannels: meta, tree, groupDim, bitDepth, modularWork,
    decodeAll(reader, streamIndex = 0) {
      admitOpen();
      decodeChannels(reader, channels, tree, parameters, streamIndex, modularWork, kernels);
      globalCount = channels.length;
      return state;
    },
    decodeGlobal(reader, streamIndex = 0) {
      admitOpen();
      requireDecode(globalCount === 0, 'Modular global stream was already decoded.');
      while (globalCount < channels.length && (globalCount < meta || channels[globalCount].width <= groupDim && channels[globalCount].height <= groupDim)) globalCount++;
      if (globalCount) decodeChannels(reader, channels.slice(0, globalCount), tree, parameters, streamIndex, modularWork, kernels);
      else if (channels.length) { const entropy = tree.entropy.start(reader, {values: 0}); entropy.begin(); entropy.finish(); }
      return state;
    },
    decodeGroup(reader, {x, y, width, height, minShift = 0, maxShift = 3, lf = false, streamIndex = 0}) {
      admitOpen();
      requireDecode([x, y, width, height].every(n => Number.isSafeInteger(n) && n >= 0), 'Invalid Modular group region.');
      const selection = [], destinations = [];
      for (let i = globalCount; i < channels.length; i++) {
        const c = channels[i], shift = Math.min(c.hshift, c.vshift);
        if (lf ? shift < 3 : shift < minShift || shift >= maxShift || shift >= 3) continue;
        requireDecode(c.hshift >= 0 && c.vshift >= 0, 'A Modular meta channel escaped the global stream.');
        const scaleX = POWERS[c.hshift], scaleY = POWERS[c.vshift];
        const left = Math.floor(x / scaleX), top = Math.floor(y / scaleY);
        const right = Math.min(c.width, Math.ceil((x + width) / scaleX)), bottom = Math.min(c.height, Math.ceil((y + height) / scaleY));
        const w = Math.max(0, right - left), h = Math.max(0, bottom - top);
        if (!w || !h) continue;
        selection.push({width: w, height: h, hshift: c.hshift, vshift: c.vshift, data: EMPTY_I32, decoded: 0, regions: null});
        destinations.push({channel: c, left, top, width: w, height: h});
      }
      if (!selection.length) return state;
      const decoded = decodeModularStream(reader, selection, {globalTree: tree, groupDim, bitDepth, maxSamples, maxModularWork, modularWork, streamIndex, kernels});
      for (let i = 0; i < destinations.length; i++) {
        const {channel: c, left, top, width: w, height: h} = destinations[i];
        c.regions ??= [];
        requireDecode(!c.regions.some(q => left < q[0] + q[2] && left + w > q[0] && top < q[1] + q[3] && top + h > q[1]), 'Overlapping Modular groups.');
        c.regions.push([left, top, w, h]);
        if (!c.data.length) c.data = new Int32Array(c.width * c.height);
        for (let row = 0; row < h; row++) c.data.set(decoded[i].data.subarray(row * w, (row + 1) * w), (top + row) * c.width + left);
        c.decoded = (c.decoded ?? 0) + w * h;
      }
      return state;
    },
    finish() {
      admitOpen();
      for (const c of channels) {
        const count = c.width * c.height;
        requireDecode((c.decoded ?? 0) === count, 'JPEG XL Modular image has missing groups.');
        if (!c.data) c.data = EMPTY_I32;
      }
      closed = true;
      return transforms.length ? part('transforms').inverseModularTransforms(channels, transforms, bitDepth) : channels;
    },
  };
  return state;
}

export function decodeModularStream(r, channels, options = {}) {
  const image = createModular(r, channels, options);
  image.decodeAll(r, options.streamIndex ?? 0);
  return image.finish();
}
