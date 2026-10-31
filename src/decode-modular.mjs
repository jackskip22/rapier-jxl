// SPDX-License-Identifier: MIT
import {readEntropy, streamSizes, writeStream, syncStream} from './decode-entropy.mjs';
import {streamKernels} from './decode-kernels.mjs';
import {requireDecode, unpackSigned} from './decode-bits.mjs';
import {DEFAULT_WEIGHTED, RECIPROCAL} from './decode-modular-weights.mjs';
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

function propertyPlan(tree, root) {
  const {property, value} = tree, thresholds = [], stack = [root];
  let tested = -1;
  while (stack.length) {
    const node = stack.pop();
    if (property[node] < 0) continue;
    if (tested >= 0 && property[node] !== tested || !Number.isInteger(value[node]) || Math.abs(value[node]) > 1073741824 || thresholds.length === 256) return null;
    tested = property[node]; thresholds.push(value[node]); stack.push(tree.left[node], tree.right[node]);
  }
  if (tested < 0) return null;
  const low = Math.min(...thresholds), size = Math.max(...thresholds) - low + 2;
  return size > 4096 ? null : {tested, low, high: low + size - 1, size, leaf: null, depth: null};
}
function propertyTable(tree, root, samples) {
  if (!tree.tables.has(root)) tree.tables.set(root, propertyPlan(tree, root));
  const plan = tree.tables.get(root);
  if (!plan || plan.size > samples) return null;
  if (!plan.leaf) {
    const {property, value, left, right} = tree, leaf = new Int32Array(plan.size), depth = new Int32Array(plan.size);
    for (let k = 0; k < plan.size; k++) {
      let node = root, steps = 0;
      while (property[node] >= 0) { steps++; node = plan.low + k > value[node] ? left[node] : right[node]; }
      leaf[k] = node; depth[k] = steps;
    }
    plan.leaf = leaf; plan.depth = depth;
  }
  return plan;
}

function streamChannels(entropy, tree, channels) {
  const kernels = streamKernels(), nodes = tree.local.property.length, stream = streamSizes(entropy);
  let stride = 2;
  for (const c of channels) stride = Math.max(stride, c.width + 2);
  const sizes = [...stream, nodes * 32, 4096 * 8, 44, 5 * stride * 8, 65 * 4, 128, channels.length * 4, ...channels.map(c => c.width * c.height * 4)];
  let end = kernels.arena;
  for (const size of sizes) {
    requireDecode(Number.isSafeInteger(size) && size >= 0, 'Invalid Modular channel dimensions.');
    end += Math.ceil(size / 16) * 16;
    if (end > 0x80000000) throw Object.assign(new RangeError('JPEG XL kernel memory request exceeds its limit.'), {code: 'JXL_MEMORY'});
  }
  const at = kernels.reserve(sizes), [nodeAt, leafAt, parametersAt, weightedAt, reciprocalsAt, io, refsAt] = at.slice(stream.length, stream.length + 7);
  const block = writeStream(kernels, entropy, at.slice(0, stream.length)), i32 = kernels.i32;
  const {property, value, left, right, context, predictor, offset, multiplier} = tree.local;
  for (let k = 0, p = nodeAt / 4; k < nodes; k++, p += 8) {
    i32[p] = property[k]; i32[p + 1] = value[k]; i32[p + 2] = left[k]; i32[p + 3] = right[k];
    i32[p + 4] = context[k]; i32[p + 5] = predictor[k]; i32[p + 6] = offset[k]; i32[p + 7] = multiplier[k];
  }
  new Uint32Array(kernels.buffer, reciprocalsAt, 65).set(RECIPROCAL);
  return {kernels, i32, block, samples: at.slice(stream.length + 7), nodeAt, leafAt, parametersAt, weightedAt, reciprocalsAt, io, refsAt, stride};
}
function kernelLocal(K, channel, samples, referencesAt, referenceCount, tree, root, parameters, channelIndex, streamIndex, remaining) {
  const {kernels, i32} = K, width = channel.width, height = channel.height;
  const table = propertyTable(tree.local, root, width * height);
  if (table) { i32.set(table.leaf, K.leafAt / 4); i32.set(table.depth, K.leafAt / 4 + 4096); }
  if (parameters) i32.set(parameters, K.parametersAt / 4);
  i32.fill(0, K.weightedAt / 4, K.weightedAt / 4 + 10 * K.stride);
  const io = K.io / 4;
  i32.fill(0, io, io + 32);
  i32.set([samples, width, height, K.nodeAt, root, table ? K.leafAt : 0, K.leafAt + 4096 * 4, table?.tested ?? 0, table?.low ?? 0, table?.high ?? 0,
    parameters ? K.parametersAt : 0, K.weightedAt, channelIndex, streamIndex, 0, K.block, referencesAt, referenceCount], io);
  i32[io + 23] = K.reciprocalsAt; kernels.f64[K.io / 8 + 12] = remaining;
  const fault = kernels.modular(K.io);
  return {remaining: kernels.f64[K.io / 8 + 12], fault};
}

export function decodeLocal(channel, tree, root, parameters, channelIndex, streamIndex, entropy, remaining, modularWork, references = []) {
  const wrapped = {local: tree}, shapes = [...references.map(data => ({width: channel.width, height: channel.height, data})), channel];
  const K = streamChannels(entropy, wrapped, shapes);
  references.forEach((data, k) => K.i32.set(data, K.samples[k] / 4));
  K.i32.set(K.samples.slice(0, references.length), K.refsAt / 4);
  const result = kernelLocal(K, channel, K.samples[references.length], K.refsAt, references.length, wrapped, root, parameters, channelIndex, streamIndex, remaining);
  syncStream(K.kernels, entropy, K.block, result.fault === 5 ? 0 : result.fault);
  if (result.fault === 5) workLimit(modularWork, -1);
  channel.data = new Int32Array(K.kernels.buffer, K.samples[references.length], channel.width * channel.height).slice();
  return result.remaining;
}

function decodeChannels(r, channels, tree, parameters, streamIndex, modularWork) {
  if (!channels.length) return;
  let values = 0, distanceMultiplier = 0;
  for (const c of channels) { values += c.width * c.height; distanceMultiplier = Math.max(distanceMultiplier, c.width); }
  let remaining = modularWork.remaining - 2 * values;
  modularWork.remaining = remaining;
  if (remaining < 0) workLimit(modularWork, remaining);
  const entropy = tree.entropy.start(r, {values, distanceMultiplier});
  entropy.begin();
  tree.local ??= localTree(tree.nodes);
  const K = streamChannels(entropy, tree, channels), nodes = tree.nodes;
  const shapes = new Map(), lists = new Int32Array(channels.length);
  channels.forEach((c, i) => {
    const key = c.width + ',' + c.height + ',' + c.hshift + ',' + c.vshift;
    let shape = shapes.get(key);
    if (!shape) shapes.set(key, shape = {indices: [], seen: 0, at: 0});
    shape.indices.push(i);
  });
  let slot = 0;
  for (const shape of shapes.values()) { shape.at = K.refsAt + slot * 4; for (const i of shape.indices) lists[slot++] = K.samples[i]; }
  K.i32.set(lists, K.refsAt / 4);
  const shapeOf = channels.map(c => shapes.get(c.width + ',' + c.height + ',' + c.hshift + ',' + c.vshift));
  let fault = 0;
  for (let channelIndex = 0; channelIndex < channels.length && !fault; channelIndex++) {
    const channel = channels[channelIndex], count = channel.width * channel.height;
    channel.decoded = count;
    if (!count) continue;
    const shape = shapeOf[channelIndex];
    let rootIndex = 0;
    while (nodes[rootIndex].property === 0 || nodes[rootIndex].property === 1) {
      if (--remaining < 0) workLimit(modularWork, remaining);
      const root = nodes[rootIndex];
      rootIndex = (root.property === 0 ? channelIndex : streamIndex) > root.value ? root.left : root.right;
    }
    ({remaining, fault} = kernelLocal(K, channel, K.samples[channelIndex], shape.at, tree.local.references ? shape.seen : 0, tree, rootIndex, tree.weighted ? parameters : null, channelIndex, streamIndex, remaining));
    shape.seen++;
    modularWork.remaining = remaining;
  }
  syncStream(K.kernels, entropy, K.block, fault === 5 ? 0 : fault);
  if (fault === 5) workLimit(modularWork, -1);
  channels.forEach((channel, c) => { channel.data = new Int32Array(K.kernels.buffer, K.samples[c], channel.width * channel.height).slice(); });
  entropy.finish();
}

export function createModular(r, inputChannels, options = {}) {
  const {globalTree, groupDim = 256, bitDepth = 8, maxSamples = DEFAULT_MAX_SAMPLES, maxModularWork = DEFAULT_MAX_WORK} = options;
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
      decodeChannels(reader, channels, tree, parameters, streamIndex, modularWork);
      globalCount = channels.length;
      return state;
    },
    decodeGlobal(reader, streamIndex = 0) {
      admitOpen();
      requireDecode(globalCount === 0, 'Modular global stream was already decoded.');
      while (globalCount < channels.length && (globalCount < meta || channels[globalCount].width <= groupDim && channels[globalCount].height <= groupDim)) globalCount++;
      if (globalCount) decodeChannels(reader, channels.slice(0, globalCount), tree, parameters, streamIndex, modularWork);
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
      const decoded = decodeModularStream(reader, selection, {globalTree: tree, groupDim, bitDepth, maxSamples, maxModularWork, modularWork, streamIndex});
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
