// SPDX-License-Identifier: MIT
import {BitWriter, FRAME_SIZE, complete} from './bits.mjs';
import {photoCoefficientSteps} from './photo-dct.mjs';
import {coefficientAnsSteps} from './coefficient-ans.mjs';
import {lowCoefficientSteps} from './photo-low.mjs';
import {captureBand, CAPTURE_BASE, CAPTURE_PATCHES, CAPTURE_TOOLS, CAPTURE_TOOLS_LEAN} from './capture-codec.mjs';
import {writeHeaderFields} from './frame.mjs';
import {fault} from './fault.mjs';
import {fileHeader, boxHeader, CODESTREAM} from './container.mjs';
import {encodeLayersSteps} from './layers-core.mjs';
import {fillHoles, maskComponents} from './screen-photo-mask.mjs';

const GAP = 24, SPARSE = 1.65, SLACK = 512, FRAMES = 8, MIN_PREPARED_FREE = 4096;

const union = (a, b) => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return {x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y};
};
const area = b => b.width * b.height;

export function maskBoxes(mask, w, h) {
  const boxes = maskComponents(mask, w, h);
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < boxes.length && !merged; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j], u = union(a, b);
      if (u.x <= Math.max(a.x, b.x) + GAP && u.y <= Math.max(a.y, b.y) + GAP && area(u) <= (area(a) + area(b)) * SPARSE + SLACK) {
        boxes[i] = u; boxes.splice(j, 1); merged = true; break;
      }
    }
  }
  while (boxes.length > FRAMES) {
    let bi = 0, bj = 1, best = Infinity;
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const cost = area(union(boxes[i], boxes[j])) - area(boxes[i]) - area(boxes[j]);
      if (cost < best) { best = cost; bi = i; bj = j; }
    }
    boxes[bi] = union(boxes[bi], boxes[bj]); boxes.splice(bj, 1);
  }
  return boxes;
}

const OVERLAY_HEAD = 31;
function overlayFrame(file, head, {x, y, width, height}, last, canvas) {
  const bit = i => file[i >> 3] >> (i & 7) & 1, read = (at, n) => { let v = 0; for (let i = 0; i < n; i++) v |= bit(at + i) << i; return v; };
  const at = head * 8;
  if (read(at, 7) !== 8 || read(at + 7, 4) || read(at + 13, 3) || read(at + 16, 4) || read(at + 20, 1) !== 1 || read(at + 21, 11))
    throw fault('JXL_INPUT', 'layer: single frame required');
  const shift = read(at + 11, 2), w = new BitWriter(64);
  w.write(13, 8 | shift << 11);
  const cropped = x || y || width !== canvas.width || height !== canvas.height;
  w.write(2, 0); w.write(1, cropped ? 1 : 0);
  if (cropped) { w.writeU32(FRAME_SIZE, 2 * x); w.writeU32(FRAME_SIZE, 2 * y); w.writeU32(FRAME_SIZE, width); w.writeU32(FRAME_SIZE, height); }
  w.write(7, 34); w.write(7, 34);
  w.write(1, last ? 1 : 0);
  if (!last) w.write(2, 1);
  w.write(10, 0); w.write(1, 0); w.zeroPadToByte();
  const toc = Math.ceil((at + OVERLAY_HEAD + 1) / 8), headBytes = w.finish(), out = new Uint8Array(headBytes.length + file.length - toc);
  out.set(headBytes); out.set(file.subarray(toc), headBytes.length);
  return out;
}

function toOverlayFrame(bytes, box, last, canvas) {
  const head = new BitWriter(64);
  writeHeaderFields(head, box.width, box.height, 3, true, {colorSpace: 'srgb'});
  return overlayFrame(bytes, head.finish().length, box, last, canvas);
}

function cropBoxBytes(data, width, mask, box, levels, tools, memo = null) {
  const {x: bx, y: by, width: bw, height: bh} = box;
  const prefix = `${bx},${by},${bw},${bh}|${tools.top}|`;
  let crop = null;
  const ensureCrop = () => {
    if (crop) return crop;
    crop = new Uint8Array(bw * bh * 4);
    for (let y = 0; y < bh; y++) for (let x = 0, i = (by + y) * width + bx, d = y * bw * 4; x < bw; x++, i++, d += 4) {
      if (!mask[i]) continue;
      crop[d] = data[i * 4]; crop[d + 1] = data[i * 4 + 1]; crop[d + 2] = data[i * 4 + 2]; crop[d + 3] = 255;
    }
    return crop;
  };
  let best = null;
  for (const level of levels) {
    const key = prefix + level;
    let bytes = memo?.get(key);
    if (!bytes) {
      bytes = captureBand(ensureCrop(), bw, bh, {y: 0, imageHeight: bh, imageWidth: bw, shape: {colour: 3, alpha: true},
        colorSpace: 'srgb', effort: level, [CAPTURE_TOOLS]: tools, [CAPTURE_BASE]: true, [CAPTURE_PATCHES]: false});
      memo?.set(key, bytes);
    }
    if (!best || bytes.length < best.length) best = bytes;
  }
  return best;
}

function unionLevels(effort, top) {
  const cap = Math.min(effort, top);
  return cap <= 1 ? [1] : [1, cap];
}

function splitBoxLevels(effort, top) {
  const cap = Math.min(effort, top);
  return effort <= 5 || cap <= 1 ? [1] : [1, cap];
}

export function photoTextLayers(data, width, height, mask, quality, effort = 3, tools = CAPTURE_TOOLS_LEAN, base = null, prepared = null) {
  const n = width * height;
  let masked = 0;
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3] !== 255) return null;
    masked += mask[i];
  }
  if (!masked || (prepared ? n - masked < MIN_PREPARED_FREE : masked * 4 >= n * 3)) return null;
  let filled = prepared?.filled ?? null;
  if (!filled) {
    filled = Uint8Array.from(data.subarray(0, n * 4));
    fillHoles(filled, width, height, mask);
    for (let i = 3; i < filled.length; i += 4) filled[i] = 255;
  }
  const own = base ? base(filled) : null;
  if (base && !own) return null;
  const direct = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) || (typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' && !base);
  const image = own ? null : prepared?.image ? {...prepared.image} : complete(photoCoefficientSteps(filled, width, height, quality, 'srgb', false, true));
  if (image) {
    image.alpha = filled;
    if (prepared?.smooth) image.adaptiveLFSmoothing = true;
    if (direct) image.placement = {isLastFrame: false, saveAsReference: 1};
  }
  const codeBase = e => {
    const key = `${quality}|${e}|${direct ? 1 : 0}`;
    let bytes = prepared?.bases?.get(key);
    if (!bytes) {
      bytes = complete(e <= 5 ? lowCoefficientSteps(image, e) : coefficientAnsSteps(image, e));
      prepared?.bases?.set(key, bytes);
    }
    return bytes;
  };
  let baseBytes = own;
  if (!baseBytes) {
    baseBytes = codeBase(effort);
    if (prepared?.monotonic && effort > 1) {
      const earlier = effort <= 4 ? Array.from({length: effort - 1}, (_, i) => i + 1)
        : effort === 5 ? [1, 2, 3]
        : [3, 5, ...(effort >= 7 ? [6] : [])];
      for (const e of earlier) {
        const alt = codeBase(e);
        if (alt.length < baseBytes.length) baseBytes = alt;
      }
    }
  }
  const boxes = maskBoxes(mask, width, height);
  const canvas = {width, height};
  if (!prepared) {
    const levels = [effort <= 5 ? 1 : Math.min(effort, tools.top), ...((base && effort > 5 && tools.top > 5) ? [5] : [])];
    const parts = [baseBytes];
    for (let k = 0; k < boxes.length; k++) {
      const box = boxes[k], bytes = cropBoxBytes(data, width, mask, box, levels, tools);
      if (!direct) parts.push({bytes, x: box.x, y: box.y, blend: 'blend', source: 1, ...(k + 1 < boxes.length && {saveAs: 1})});
      else parts.push(toOverlayFrame(bytes, box, k + 1 === boxes.length, canvas));
    }
    if (!direct) return complete(encodeLayersSteps({width, height, layers: [{bytes: parts[0], saveAs: 1}, ...parts.slice(1)]}));
    const big = boxes.reduce((s, b) => s + b.width * b.height, n) > 268435456, length = parts.reduce((s, p) => s + p.length, 0);
    if (big) parts.unshift(fileHeader(10), boxHeader(CODESTREAM, length));
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    for (let i = 0, at = 0; i < parts.length; at += parts[i++].length) out.set(parts[i], at);
    return out;
  }
  const uLevels = unionLevels(effort, tools.top);
  if (boxes.length === 1) {
    const box = boxes[0], bytes = cropBoxBytes(data, width, mask, box, uLevels, tools, prepared.overlays);
    if (!direct) return complete(encodeLayersSteps({width, height, layers: [{bytes: baseBytes, saveAs: 1}, {bytes, x: box.x, y: box.y, blend: 'blend', source: 1}]}));
    const parts = [baseBytes, toOverlayFrame(bytes, box, true, canvas)];
    const big = box.width * box.height + n > 268435456, length = parts.reduce((s, p) => s + p.length, 0);
    if (big) parts.unshift(fileHeader(10), boxHeader(CODESTREAM, length));
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    for (let i = 0, at = 0; i < parts.length; at += parts[i++].length) out.set(parts[i], at);
    return out;
  }
  const bLevels = splitBoxLevels(effort, tools.top);
  const splitRaw = boxes.map(box => cropBoxBytes(data, width, mask, box, bLevels, tools, prepared.overlays));
  const splitFrames = splitRaw.map((bytes, k) => toOverlayFrame(bytes, boxes[k], k + 1 === boxes.length, canvas));
  const splitTotal = splitFrames.reduce((s, f) => s + f.length, 0);
  let chosenBoxes = boxes;
  let chosenDirect = splitFrames;
  let chosenIndirect = splitRaw.map((bytes, k) => ({bytes, x: boxes[k].x, y: boxes[k].y, blend: 'blend', source: 1, ...(k + 1 < boxes.length && {saveAs: 1})}));
  const whole = boxes.reduce(union);
  if (whole.width * whole.height + n <= 268435456) {
    const oneBytes = cropBoxBytes(data, width, mask, whole, uLevels, tools, prepared.overlays);
    const oneFrame = toOverlayFrame(oneBytes, whole, true, canvas);
    if (oneFrame.length <= splitTotal) {
      chosenBoxes = [whole];
      chosenDirect = [oneFrame];
      chosenIndirect = [{bytes: oneBytes, x: whole.x, y: whole.y, blend: 'blend', source: 1}];
    }
  }
  if (!direct) return complete(encodeLayersSteps({width, height, layers: [{bytes: baseBytes, saveAs: 1}, ...chosenIndirect]}));
  const parts = [baseBytes, ...chosenDirect];
  const big = chosenBoxes.reduce((s, b) => s + b.width * b.height, n) > 268435456, length = parts.reduce((s, p) => s + p.length, 0);
  if (big) parts.unshift(fileHeader(10), boxHeader(CODESTREAM, length));
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  for (let i = 0, at = 0; i < parts.length; at += parts[i++].length) out.set(parts[i], at);
  return out;
}
