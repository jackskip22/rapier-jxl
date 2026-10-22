// SPDX-License-Identifier: MIT
import {fault} from './fault.mjs';
import {BitWriter} from './bits.mjs';
import {SIGNATURE, CODESTREAM, boxes, boxHeader} from './container.mjs';
import {inspectContainer, reframeContainer, readFrameIndex, frameIndexPayload} from './container-advanced.mjs';
import {readFrames, copyBits} from './framing.mjs';
import {writeTOCPermutation, readTOCPermutation} from './toc-permutation.mjs';

const INDEX = 0x6a786c69, TOC_ENTRY = [[10, 0], [14, 1024], [22, 17408], [30, 4211712]];
const invalid = message => fault('JXL_INPUT', message);
function maximum(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw invalid('Delivery options are an object.');
  const value = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < 1) throw invalid('maxBytes is a positive safe integer.');
  if (options.iccBitLength !== undefined && (!Number.isSafeInteger(options.iccBitLength) || options.iccBitLength < 1)) throw invalid('iccBitLength is a positive safe integer.');
  return value;
}
function bounded(size, max) {
  if (!Number.isSafeInteger(size) || size > max) throw fault('JXL_SIZE', 'JPEG XL delivery exceeds maxBytes.');
  return size;
}
function joined(parts, max) {
  const size = parts.reduce((sum, part) => bounded(sum + part.length, max), 0), output = new Uint8Array(size);
  let at = 0; for (const part of parts) { output.set(part, at); at += part.length; } return output;
}
function read(bytes, options) {
  const max = maximum(options), container = inspectContainer(bytes, {maxBytes: max});
  const parsed = readFrames(container.codestream, {iccBits: options.iccBitLength, tocPermutation: readTOCPermutation});
  return {max, container, parsed};
}
function grid(frame) {
  const dimension = 128 << frame.shift, columns = Math.ceil(Math.ceil(frame.width / frame.upsampling) / dimension);
  const rows = Math.ceil(Math.ceil(frame.height / frame.upsampling) / dimension);
  const dcGroups = Math.ceil(columns / 8) * Math.ceil(rows / 8);
  return {dimension, columns, rows, groups: columns * rows, dcGroups};
}
function physicalOrder(frame) {
  const result = frame.sizes.map((_, i) => i);
  if (frame.permutation) for (let i = 0; i < frame.permutation.length; i++) result[frame.permutation[i]] = i;
  return result;
}
function offsets(frame) {
  if (frame.sectionOffsets) return frame.sectionOffsets;
  const result = []; let offset = frame.sectionsAt;
  for (const size of frame.sizes) { result.push(offset); offset += size; } return result;
}
function sectionInfo(frame, index, offset, physicalIndex, details) {
  const result = {index, physicalIndex, byteOffset: offset, byteLength: frame.sizes[index]};
  if (frame.sizes.length === 1) return {...result, kind: 'combined'};
  if (index === 0) return {...result, kind: 'lf-global'};
  if (index <= details.dcGroups) return {...result, kind: 'dc-group', group: index - 1};
  if (index === details.dcGroups + 1) return {...result, kind: 'hf-global'};
  const ac = index - details.dcGroups - 2, group = ac % details.groups, pass = Math.floor(ac / details.groups);
  const span = details.dimension * frame.upsampling, x = group % details.columns * span, y = Math.floor(group / details.columns) * span;
  return {...result, kind: 'ac-group', group, pass, x: frame.x0 + x, y: frame.y0 + y,
    width: Math.min(span, frame.width - x), height: Math.min(span, frame.height - y)};
}
function frameInfo(frame, index) {
  const details = grid(frame), order = physicalOrder(frame), starts = offsets(frame), positions = new Uint32Array(order.length);
  for (const [physical, logical] of order.entries()) positions[logical] = physical;
  return {index, type: frame.type, dcLevel: frame.dcLevel, modular: frame.modular, width: frame.width, height: frame.height,
    byteOffset: frame.start, byteLength: frame.end - frame.start, sectionsByteOffset: frame.sectionsAt,
    groups: details.groups, dcGroups: details.dcGroups, passes: frame.passes, sectionOrder: order,
    sections: frame.sizes.map((_, logical) => sectionInfo(frame, logical, starts[logical], positions[logical], details))};
}

export function deliveryLayout(bytes, options = {}) {
  const {container, parsed} = read(bytes, options);
  return {width: parsed.image.width, height: parsed.image.height, level: container.level, imageHeaderBytes: parsed.image.end,
    codestreamBytes: parsed.codestream.length, preview: parsed.preview ? frameInfo(parsed.preview, -1) : null,
    frames: parsed.frames.map(frameInfo)};
}

function admitOrder(order, count) {
  if (!Array.isArray(order) || order.length !== count) throw invalid('sectionOrder lists every logical section once in physical delivery order.');
  const seen = new Uint8Array(count);
  for (const value of order) {
    if (!Number.isInteger(value) || value < 0 || value >= count || seen[value]) throw invalid('sectionOrder is a permutation of the logical section indexes.');
    seen[value] = 1;
  }
  return order.slice();
}
function regionOrder(frame, region, strategy, image) {
  if (frame.dcLevel) throw invalid('Region delivery selects an image or preview frame; use sectionOrder for LF dependency frames.');
  if (!region || typeof region !== 'object' || Array.isArray(region)) throw invalid('region gives x, y, width and height in un-oriented canvas pixels.');
  for (const [key, minimum] of [['x', 0], ['y', 0], ['width', 1], ['height', 1]])
    if (!Number.isSafeInteger(region[key]) || region[key] < minimum) throw invalid('The region rectangle uses nonnegative integer coordinates and positive dimensions.');
  if (region.x + region.width > image.width || region.y + region.height > image.height) throw invalid('The region rectangle lies inside the image canvas before orientation.');
  if (frame.sizes.length === 1) return [0];
  const details = grid(frame), groups = [], centerX = region.x + region.width / 2, centerY = region.y + region.height / 2;
  for (let group = 0; group < details.groups; group++) {
    const info = sectionInfo(frame, details.dcGroups + 2 + group, 0, 0, details);
    const intersects = info.x < region.x + region.width && info.x + info.width > region.x && info.y < region.y + region.height && info.y + info.height > region.y;
    const dx = info.x + info.width / 2 - centerX, dy = info.y + info.height / 2 - centerY;
    groups.push({group, intersects, distance: dx * dx + dy * dy});
  }
  groups.sort((a, b) => Number(b.intersects) - Number(a.intersects) || a.distance - b.distance || a.group - b.group);
  const firstAC = details.dcGroups + 2, order = Array.from({length: firstAC}, (_, i) => i);
  if (strategy === 'region-first') {
    for (const value of groups) if (value.intersects) for (let pass = 0; pass < frame.passes; pass++) order.push(firstAC + pass * details.groups + value.group);
    for (let pass = 0; pass < frame.passes; pass++) for (const value of groups) if (!value.intersects) order.push(firstAC + pass * details.groups + value.group);
  } else for (let pass = 0; pass < frame.passes; pass++) for (const value of groups) order.push(firstAC + pass * details.groups + value.group);
  return order;
}

function rewriteFrame(stream, frame, order, max) {
  if (order.length > 65536) throw invalid('A frame contains at most 65536 sections.');
  const inverse = new Array(order.length); for (let physical = 0; physical < order.length; physical++) inverse[order[physical]] = physical;
  const writer = new BitWriter(); copyBits(writer, stream, frame.start * 8, frame.tocAt);
  writeTOCPermutation(writer, inverse); writer.zeroPadToByte();
  for (const logical of order) writer.writeU32(TOC_ENTRY, frame.sizes[logical]);
  writer.zeroPadToByte(); const starts = offsets(frame), parts = [writer.finish()];
  for (const logical of order) parts.push(stream.subarray(starts[logical], starts[logical] + frame.sizes[logical]));
  return joined(parts, max);
}

function assemble(original, state, orders) {
  const {container, parsed, max} = state, frames = [...(parsed.preview ? [parsed.preview] : []), ...parsed.frames];
  const changed = frames.some(frame => orders.has(frame));
  if (!changed) return original.slice();
  if (container.auxiliary.some(entry => entry.boxType === 'jbrd')) throw invalid('TOC rewriting of JPEG reconstruction files is not supported; retain their original section order.');
  const starts = new Map(), parts = [parsed.codestream.subarray(0, parsed.image.end)]; let at = parsed.image.end;
  for (const frame of frames) {
    starts.set(frame.start, at);
    const bytes = orders.has(frame) ? rewriteFrame(parsed.codestream, frame, orders.get(frame), max) : parsed.codestream.subarray(frame.start, frame.end);
    bounded(at += bytes.length, max); parts.push(bytes);
  }
  const stream = joined(parts, max);
  if (original[0] === 255 && original[1] === 10) return stream;
  const canonical = reframeContainer(original, {maxBytes: max}), index = readFrameIndex(canonical, {maxBytes: max});
  if (index) for (const frame of index.frames) {
    const moved = starts.get(Number(frame.byteOffset));
    if (moved === undefined) throw invalid('A frame index must name parsed frame starts before changing TOC header lengths.');
    frame.byteOffset = moved;
  }
  const output = [SIGNATURE.slice()];
  for (const entry of boxes(canonical)) {
    if (entry.type === CODESTREAM) output.push(boxHeader(CODESTREAM, stream.length), stream);
    else if (entry.type === INDEX) {
      const payload = frameIndexPayload(index, {maxBytes: max}); output.push(boxHeader(INDEX, payload.length), payload);
    } else output.push(canonical.subarray(entry.at, entry.end));
  }
  return joined(output, max);
}

export function withDeliveryOrder(bytes, options = {}) {
  const state = read(bytes, options), {parsed} = state, strategy = options.strategy ?? 'region-first';
  if (strategy !== 'region-first' && strategy !== 'pass-first') throw invalid('strategy is region-first or pass-first.');
  const frameIndex = options.frameIndex ?? parsed.frames.length - 1;
  if (!Number.isInteger(frameIndex) || frameIndex < -1 || frameIndex >= parsed.frames.length || frameIndex === -1 && !parsed.preview)
    throw invalid('frameIndex selects a parsed frame; -1 requires a preview.');
  if (options.sectionOrder !== undefined && options.region !== undefined) throw invalid('Supply either region or sectionOrder.');
  if (options.sectionOrder === undefined && options.region === undefined) return bytes.slice();
  const frame = frameIndex === -1 ? parsed.preview : parsed.frames[frameIndex];
  const order = options.sectionOrder !== undefined ? admitOrder(options.sectionOrder, frame.sizes.length) :
    regionOrder(frame, options.region, strategy, frameIndex === -1 ? parsed.image.preview : parsed.image);
  const original = physicalOrder(frame);
  return assemble(bytes, state, new Map(order.every((value, i) => value === original[i]) ? [] : [[frame, order]]));
}

export function normalizeDelivery(bytes, options = {}) {
  const state = read(bytes, options), frames = [...(state.parsed.preview ? [state.parsed.preview] : []), ...state.parsed.frames];
  const orders = new Map(); for (const frame of frames) if (frame.permutation) orders.set(frame, frame.sizes.map((_, i) => i));
  return assemble(bytes, state, orders);
}
