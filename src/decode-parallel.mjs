// SPDX-License-Identifier: MIT
import {decodeImage, decodeImageSteps, decodeOptions, outputFormat} from './decode-image.mjs';
import {decodeFrameSections, jpegShifts, restoreFrame} from './decode-frame.mjs';
import {frameFeatures} from './decode-parts.mjs';
import {transformColor, nativeEncoding, sameEncoding, targetEncoding} from './decode-color.mjs';
import {rgbaPixels} from './decode-compose.mjs';
import {trimDecodeKernels} from './decode-kernels.mjs';
import {plainFrame} from './decode-region.mjs';

const groupRows = f => Math.ceil(f.height / 256);
const rgbaArray = (format, length) => new (format === 'float32' ? Float32Array : format === 'uint16' ? Uint16Array : Uint8Array)(length);
const canReference = f => !f.isLast && (f.duration === 0 || f.saveAsReference !== 0);

function bandable(h, f, options) {
  return !!f && !h.preview && windowable(h, f, options.borrowed && options.withoutNoise) &&
    (f.isLast || f.duration !== 0) && !canReference(f) && f.blending[0].mode === 0 &&
    !f.x0 && !f.y0 && f.width === h.width && f.height === h.height && directColor(h, options);
}
function directColor(h, options) {
  if (options.applyOrientation && h.orientation !== 1) return false;
  const original = nativeEncoding(h), transfer = original.transferFunction ?? (original.gamma === undefined ? 'srgb' : 'gamma');
  if (original.wantICC || original.space !== 'rgb' || h.xyb && transfer !== 'srgb') return false;
  return options.colorSpace === 'original' || typeof options.colorSpace === 'string' && options.colorSpace !== 'xyb' && sameEncoding(original, targetEncoding(options.colorSpace));
}

function renderBand(readers, h, f, options, first, end, emit = null, left = 0, right = Math.ceil(f.width / 256)) {
  const width = Math.min(f.width, right * 256) - left * 256, top = first * 256, bottom = Math.min(f.height, end * 256), format = outputFormat(h, options);
  const planes = emit || !options.planes ? null : [0, 1, 2].map(() => new Float32Array((bottom - top) * width)), data = emit ? null : rgbaArray(format, (bottom - top) * width * 4);
  const target = (a, b) => planes ? planes.map(p => p.subarray((a - top) * width, (b - top) * width)) : [0, 1, 2].map(() => new Float32Array((b - a) * width));
  const restored = (a, b, rows) => {
    const count = b - a, inKernels = band.kernel && rows[0].buffer !== planes?.[0].buffer, rgbaRows = data?.subarray((a - top) * width * 4, (b - top) * width * 4);
    const target = inKernels && format === 'uint8' ? new Uint8Array(rows[0].buffer, band.kernel.rgba, count * width * 4) : inKernels ? null : rgbaRows;
    const rgba8 = !options.planes && format === 'uint8' ? target ?? new Uint8Array(count * width * 4) : null;
    const frame = transformColor({width, height: count, planes: rows, widths: [width, width, width], heights: [count, count, count], extraChannels: []},
      h, f, {colorSpace: 'original', inPlace: true, rgba8});
    const rgba = frame.rgba8 ?? rgbaPixels(frame, format, options.unpremultiplyAlpha, options.renderSpotColors, target, {at: band.kernel.rgba, bytes: band.kernel.rgbaBytes});
    if (!inKernels) {
      if (planes && frame.planes[0] !== rows[0]) for (let c = 0; c < 3; c++) planes[c].set(frame.planes[c], (a - top) * width);
      return emit?.(a, options.planes ? frame.planes : null, rgba);
    }
    if (!emit) { if (planes) for (let c = 0; c < 3; c++) planes[c].set(frame.planes[c], (a - top) * width); if (rgba !== rgbaRows) rgbaRows.set(rgba); }
    else emit(a, options.planes ? frame.planes.map(p => p.slice()) : null, rgba.buffer === rows[0].buffer ? rgba.slice() : rgba);
  };
  const band = {first, end, left, right, target, restored};
  const {dct} = decodeFrameSections(readers, h, f, {readFeatures: frameFeatures,
    maxSamples: options.maxSamples, maxModularWork: options.maxModularWork, band});
  return {dct, planes, data, format};
}

function window(f, x, y, width, height) {
  return {first: Math.max(0, Math.floor(y / 256) - 1), end: Math.min(groupRows(f), Math.ceil((y + height) / 256) + 1),
    left: Math.max(0, Math.floor(x / 256) - 1), right: Math.min(Math.ceil(f.width / 256), Math.ceil((x + width) / 256) + 1)};
}
function regionBand(readers, h, f, options, area) {
  const {first, end, left, right} = window(f, area.x, area.y, area.width, area.height), width = Math.min(f.width, right * 256) - left * 256, x = area.x - left * 256;
  const format = outputFormat(h, options), data = rgbaArray(format, area.width * area.height * 4);
  const planes = options.planes ? [0, 1, 2].map(() => new Float32Array(area.width * area.height)) : null;
  const top = area.y, bottom = area.y + area.height;
  renderBand(readers, h, f, options, first, end, (a, rowPlanes, rgba) => {
    const count = rgba.length / (width * 4);
    for (let y = Math.max(a, top); y < Math.min(a + count, bottom); y++) {
      const from = (y - a) * width + x, to = (y - top) * area.width;
      data.set(rgba.subarray(from * 4, (from + area.width) * 4), to * 4);
      if (planes) for (let c = 0; c < 3; c++) planes[c].set(rowPlanes[c].subarray(from, from + area.width), to);
    }
  }, left, right);
  return Object.assign(bandFrame({...h, width: area.width, height: area.height}, {...f, width: area.width, height: area.height},
    planes ?? [0, 1, 2].map(() => new Float32Array(0)), data, format), {regional: {x0: 0, y0: 0}});
}

const windowable = (h, f, withoutNoise = false) => !h.extraChannels.length &&
  plainFrame(withoutNoise ? {...f,flags:f.flags & ~1n} : f);
function regionFrame(readers, h, f, options, area, chroma = false) {
  const x0 = Math.max(area.x, f.x0) - f.x0, y0 = Math.max(area.y, f.y0) - f.y0;
  const width = Math.min(area.x + area.width, f.x0 + f.width) - f.x0 - x0, height = Math.min(area.y + area.height, f.y0 + f.height) - f.y0 - y0;
  const {first, end, left, right} = window(f, x0, y0, width, height), span = Math.min(f.width, right * 256) - left * 256, x = x0 - left * 256;
  const planes = [0, 1, 2].map(() => new Float32Array(width * height));
  const band = {first, end, left, right, target: (a, b) => [0, 1, 2].map(() => new Float32Array((b - a) * span)), restored(a, b, rows) {
    for (let y = Math.max(a, y0); y < Math.min(b, y0 + height); y++) for (let c = 0; c < 3; c++) planes[c].set(rows[c].subarray((y - a) * span + x, (y - a) * span + x + width), (y - y0) * width);
  }};
  let sampled;
  if (chroma) {
    const {hs, vs} = jpegShifts(f.jpegUpsampling), top = first * 256, height = Math.min(f.height, end * 256) - top;
    const widths = hs.map(s => Math.ceil(span / 2 ** s)), heights = vs.map(s => Math.ceil(height / 2 ** s));
    sampled = {width: span, height, widths, heights, planes: widths.map((w, c) => new Float32Array(w * heights[c])), filtersApplied: true};
    band.subsampled = (a, rows) => rows.forEach((p, c) => sampled.planes[c].set(p, ((a - top) >> vs[c]) * widths[c]));
  }
  const {features} = decodeFrameSections(readers, h, f, {readFeatures: frameFeatures,
    maxSamples: options.maxSamples, maxModularWork: options.maxModularWork, band});
  if (sampled) band.restored(first * 256, Math.min(f.height, end * 256), restoreFrame(sampled, f).planes);
  return {width, height, widths: [width, width, width], heights: [height, height, height], planes, extraChannels: [], features, filtersApplied: true,
    x0: f.x0 + x0, y0: f.y0 + y0, saveBeforeColorTransform: f.saveBeforeColorTransform, regional: {x0: f.x0 + x0 - area.x, y0: f.y0 + y0 - area.y, width, height}};
}

function regionModular(readers, h, f, options, area) {
  if (f.type !== 0 || !f.modular || f.ycbcr || h.xyb || f.upsampling !== 1 || f.lfLevel || f.useLFFrame || f.flags & 19n ||
      f.encodedWidth !== f.width || f.encodedHeight !== f.height || f.filter.gaborish || f.filter.epf.iters ||
      h.extraChannels.some((c, i) => c.dimShift || f.extraUpsampling[i] !== 1)) return null;
  const x = Math.max(area.x, f.x0) - f.x0, y = Math.max(area.y, f.y0) - f.y0;
  const width = Math.min(area.x + area.width, f.x0 + f.width) - f.x0 - x, height = Math.min(area.y + area.height, f.y0 + f.height) - f.y0 - y;
  const bit = readers[0].bit, frame = decodeFrameSections(readers, h, f, {readFeatures: frameFeatures,
    maxSamples: options.maxSamples, maxModularWork: options.maxModularWork, region: {x, y, width, height}});
  if (!frame) { readers[0].bit = bit; return null; }
  return {...frame, filtersApplied: true, x0: f.x0 + x, y0: f.y0 + y, saveBeforeColorTransform: f.saveBeforeColorTransform,
    regional: {x0: f.x0 + x - area.x, y0: f.y0 + y - area.y, width, height}};
}

function bandFrame(h, f, planes, data, format) {
  const width = f.width, height = f.height;
  return {width, height, widths: [width, width, width], heights: [height, height, height], planes, extraChannels: [], x0: 0, y0: 0,
    colorEncoding: nativeEncoding(h), icc: undefined, ctDone: true, saveBeforeColorTransform: f.saveBeforeColorTransform, rgba: {format, planes, data}};
}

function stackable(h, frames, options) {
  if (h.preview || h.animation || h.extraChannels.length || frames.length < 2 || !directColor(h, options)) return false;
  let y = 0, slot = -1;
  for (const f of frames) {
    if (!windowable(h, f) || f.blending[0].mode !== 0 || slot >= 0 && f.blending[0].source !== slot || f.x0 !== 0 || f.width !== h.width || f.y0 !== y) return false;
    if (!f.isLast) { if (f.duration !== 0 || f.saveBeforeColorTransform) return false; slot = f.saveAsReference; }
    y += f.height;
  }
  return y === h.height;
}
function stacker(h, options) {
  const format = outputFormat(h, options), width = h.width, data = rgbaArray(format, width * h.height * 4);
  const planes = options.planes ? [0, 1, 2].map(() => new Float32Array(width * h.height)) : null;
  return {
    add(readers, f) {
      renderBand(readers, h, f, options, 0, groupRows(f), (a, rowPlanes, rgba) => {
        const at = (f.y0 + a) * width, rows = rgba.length / (width * 4);
        data.set(rgba, at * 4);
        if (planes) for (let c = 0; c < 3; c++) planes[c].set(rowPlanes[c].subarray(0, rows * width), at);
      });
    },
    frame: () => bandFrame(h, h, planes ?? [0, 1, 2].map(() => new Float32Array(0)), data, format),
  };
}

const banding = (options, render) => Object.assign(render, {bandable: (h, f) => bandable(h, f, options),
  stack: (h, frames) => stackable(h, frames, options) ? stacker(h, options) : null});
export function decodeBands(bytes, options, opened = null) {
  try { return decodeBands1(bytes, options, opened); } finally { trimDecodeKernels(); }
}
export async function decodeBandsAsync(bytes, options, opened = null) {
  const steps = decodeBandsSteps(bytes, options, opened);
  try {
    for (;;) { const step = steps.next(); if (step.done) return step.value; await options.onFrame(...step.value); }
  } finally { try { steps.return?.(); } finally { trimDecodeKernels(); } }
}
function decodeBands1(bytes, options, opened) {
  return decodeImage(bytes, options, bandRenderer(options), opened);
}
function decodeBandsSteps(bytes, options, opened) {
  return decodeImageSteps(bytes, options, bandRenderer(options), opened);
}
const bandRenderer = options => banding(options, (readers, h, f, codestream, area) => {
    if (area && f.modular) return regionModular(readers, h, f, options, area);
    if (area && f.ycbcr && f.jpegUpsampling.some(Boolean) && !h.extraChannels.length && !f.filter.gaborish && !f.filter.epf.iters &&
        plainFrame({...f, jpegUpsampling: [0, 0, 0]})) return regionFrame(readers, h, f, options, area, true);
    if (area && !bandable(h, f, options)) return windowable(h, f, options.borrowed && options.withoutNoise) ? regionFrame(readers, h, f, options, area) : null;
    if (!bandable(h, f, options)) return null;
    if (area) return regionBand(readers, h, f, options, area);
    const {planes, data, format} = renderBand(readers, h, f, options, 0, groupRows(f));
    return bandFrame(h, f, planes ?? [0, 1, 2].map(() => new Float32Array(0)), data, format);
  });
