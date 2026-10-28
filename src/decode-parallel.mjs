// SPDX-License-Identifier: MIT
import {requireDecode} from './decode-bits.mjs';
import {decodeImage, decodeOptions, openFirstFrame, outputFormat} from './decode-image.mjs';
import {decodeFrameSections} from './decode-frame.mjs';
import {frameFeatures, loadPart} from './decode-parts.mjs';
import {transformColor, nativeEncoding, sameEncoding, targetEncoding} from './decode-color.mjs';
import {rgbaPixels} from './decode-compose.mjs';

const BAND_WORKER = 'rapier-jxl-decode';
const nodeThreads = globalThis.process?.getBuiltinModule?.('node:worker_threads');
const groupRows = f => Math.ceil(f.height / 256);
const rgbaArray = (format, length) => new (format === 'float32' ? Float32Array : format === 'uint16' ? Uint16Array : Uint8Array)(length);

function bandable(h, f, options) {
  if (!f || h.preview || h.animation || h.extraChannels.length || !f.isLast || f.type !== 0 || f.modular) return false;
  if (f.ycbcr && f.jpegUpsampling.some(Boolean) || f.upsampling !== 1 || f.lfLevel || f.useLFFrame || (f.flags & 19n) || f.blending[0].mode !== 0) return false;
  if (f.x0 || f.y0 || f.width !== h.width || f.height !== h.height || f.encodedWidth !== f.width || f.encodedHeight !== f.height) return false;
  if (options.applyOrientation && h.orientation !== 1) return false;
  const original = nativeEncoding(h), transfer = original.transferFunction ?? (original.gamma === undefined ? 'srgb' : 'gamma');
  if (original.wantICC || original.space !== 'rgb' || h.xyb && transfer !== 'srgb') return false;
  return options.colorSpace === 'original' || typeof options.colorSpace === 'string' && options.colorSpace !== 'xyb' && sameEncoding(original, targetEncoding(options.colorSpace));
}

function renderBand(readers, h, f, options, first, end, emit = null) {
  const width = f.width, top = first * 256, bottom = Math.min(f.height, end * 256), format = outputFormat(h, options);
  const planes = emit || !options.planes ? null : [0, 1, 2].map(() => new Float32Array((bottom - top) * width)), data = emit ? null : rgbaArray(format, (bottom - top) * width * 4);
  const target = (a, b) => planes ? planes.map(p => p.subarray((a - top) * width, (b - top) * width)) : [0, 1, 2].map(() => new Float32Array((b - a) * width));
  const restored = (a, b, rows) => {
    const count = b - a, inKernels = band.kernel && rows[0].buffer !== planes?.[0].buffer, rgbaRows = data?.subarray((a - top) * width * 4, (b - top) * width * 4);
    const target = inKernels && format === 'uint8' ? new Uint8Array(rows[0].buffer, band.kernel.rgba, count * width * 4) : inKernels ? null : rgbaRows;
    const rgba8 = !options.planes && format === 'uint8' ? target ?? new Uint8Array(count * width * 4) : null;
    const frame = transformColor({width, height: count, planes: rows, widths: [width, width, width], heights: [count, count, count], extraChannels: []},
      h, f, {colorSpace: 'original', inPlace: true, rgba8});
    const rgba = frame.rgba8 ?? rgbaPixels(frame, format, options.unpremultiplyAlpha, options.renderSpotColors, target);
    if (!inKernels) {
      if (planes && frame.planes[0] !== rows[0]) for (let c = 0; c < 3; c++) planes[c].set(frame.planes[c], (a - top) * width);
      return emit?.(a, options.planes ? frame.planes : null, rgba);
    }
    if (!emit) { if (planes) for (let c = 0; c < 3; c++) planes[c].set(frame.planes[c], (a - top) * width); if (rgba !== rgbaRows) rgbaRows.set(rgba); }
    else emit(a, options.planes ? frame.planes.map(p => p.slice()) : null, rgba.buffer === rows[0].buffer ? rgba.slice() : rgba);
  };
  const band = {first, end, target, restored};
  const {dct} = decodeFrameSections(readers, h, f, {readFeatures: (r, h, f) => frameFeatures(r, h, f, options),
    maxSamples: options.maxSamples, maxModularWork: options.maxModularWork, band});
  return {dct, planes, data, format};
}

function bandFrame(h, f, planes, data, format) {
  const width = f.width, height = f.height;
  return {width, height, widths: [width, width, width], heights: [height, height, height], planes, extraChannels: [], x0: 0, y0: 0,
    colorEncoding: nativeEncoding(h), icc: undefined, ctDone: true, saveBeforeColorTransform: f.saveBeforeColorTransform, rgba: {format, planes, data}};
}

export function decodeBands(bytes, options) {
  return decodeImage(bytes, options, (readers, h, f) => {
    if (!bandable(h, f, options)) return null;
    const {planes, data, format} = renderBand(readers, h, f, options, 0, groupRows(f));
    return bandFrame(h, f, planes ?? [0, 1, 2].map(() => new Float32Array(0)), data, format);
  });
}

function serveBands(post, listen) {
  let state = null;
  listen(async message => {
    for (;;) try {
      if (message.type === 'band') {
        const {bytes, options, first, end} = message, {h, f, readers} = openFirstFrame(bytes, options);
        const emit = (top, planes, data) => post({type: 'rows', top, planes, data}, [...(planes ?? []).map(p => p.buffer), data.buffer]);
        state = renderBand(readers, h, f, options, first, end, emit);
        const {above, below} = state.dct.bandEdges();
        post({type: 'edges', above, below}, [...above, ...below].map(p => p.buffer));
      } else if (message.type === 'halo') {
        state.dct.finishBand(message.above, message.below);
        state = null;
        post({type: 'done'});
      }
      return;
    } catch (error) {
      try { if (await loadPart(error)) continue; } catch (failure) { error = failure; }
      state = null; post({type: 'error', message: error?.message ?? String(error)}); return;
    }
  });
}
if (nodeThreads && !nodeThreads.isMainThread && nodeThreads.workerData === BAND_WORKER) {
  const port = nodeThreads.parentPort;
  serveBands((message, transfer) => port.postMessage(message, transfer), handler => port.on('message', handler));
} else if (typeof WorkerGlobalScope === 'function' && self.name === BAND_WORKER) {
  serveBands((message, transfer) => self.postMessage(message, transfer), handler => self.addEventListener('message', event => handler(event.data)));
}

const idleWorkers = [];
function bandWorker() {
  const reused = idleWorkers.pop();
  if (reused) { clearTimeout(reused.timer); reused.ref(); return reused; }
  const worker = {handler: null, timer: 0};
  const deliver = message => worker.handler?.(message);
  if (nodeThreads) {
    const flags = globalThis.process.execArgv, execArgv = flags.some(flag => flag.startsWith('--input-type')) ? flags.filter(flag => !flag.startsWith('--input-type')) : undefined;
    const thread = new nodeThreads.Worker(new URL(import.meta.url), {workerData: BAND_WORKER, execArgv});
    thread.on('message', deliver); thread.on('error', error => deliver({type: 'error', message: error.message}));
    Object.assign(worker, {post: (message, transfer) => thread.postMessage(message, transfer), end: () => thread.terminate(),
      ref: () => thread.ref(), unref: () => thread.unref()});
  } else {
    const thread = new Worker(import.meta.url, {type: 'module', name: BAND_WORKER});
    thread.onmessage = event => deliver(event.data);
    thread.onerror = event => { event.preventDefault?.(); deliver({type: 'error', message: event.message}); };
    Object.assign(worker, {post: (message, transfer) => thread.postMessage(message, transfer), end: () => thread.terminate(),
      ref: () => {}, unref: () => { worker.timer = setTimeout(() => { idleWorkers.splice(idleWorkers.indexOf(worker), 1); thread.terminate(); }, 10000); }});
  }
  return worker;
}

function runBands(bytes, options, bands, rows) {
  const workers = [];
  let failed = false;
  return new Promise((resolve, reject) => {
    const edges = new Array(bands.length);
    let edgeCount = 0, doneCount = 0;
    const fail = message => { if (!failed) { failed = true; reject(new Error(message)); } };
    bands.forEach(([first, end], index) => {
      const worker = bandWorker(); workers.push(worker);
      worker.handler = message => {
        if (failed) return;
        if (message.type === 'error') return fail(message.message);
        if (message.type === 'edges') {
          edges[index] = message;
          if (++edgeCount === bands.length) workers.forEach((w, i) => {
            const above = i ? edges[i - 1].below : null, below = i + 1 < bands.length ? edges[i + 1].above : null;
            w.post({type: 'halo', above, below});
          });
        } else if (message.type === 'rows') rows(message.top, message.planes, message.data);
        else if (message.type === 'done' && ++doneCount === bands.length) resolve();
      };
      worker.post({type: 'band', bytes, options, first, end});
    });
  }).finally(() => workers.forEach(worker => {
    worker.handler = null;
    if (failed) worker.end(); else { worker.unref(); idleWorkers.push(worker); }
  }));
}

export async function decodeAsync(bytes, options = {}) {
  options = decodeOptions(options);
  const threads = options.threads ?? Math.min(8, globalThis.navigator?.hardwareConcurrency ?? 1);
  requireDecode(Number.isSafeInteger(threads) && threads >= 1, 'JPEG XL decode threads is a positive integer.');
  let probe = null;
  try { decodeImage(bytes, options, (readers, h, f) => { throw probe = {readers, h, f}; }); } catch (error) { if (error !== probe) throw error; }
  const {readers, h, f} = probe, rows = groupRows(f), count = Math.min(threads, rows);
  if (count < 2 || readers.length < 2 || !bandable(h, f, options) || !(nodeThreads || typeof Worker === 'function')) return decodeBands(bytes, options);
  const bands = Array.from({length: count}, (_, i) => [Math.floor(i * rows / count), Math.floor((i + 1) * rows / count)]);
  const width = f.width, format = outputFormat(h, options);
  const planes = [0, 1, 2].map(() => new Float32Array(options.planes ? width * f.height : 0)), data = rgbaArray(format, width * f.height * 4);
  try {
    await runBands(bytes, options, bands, (top, rows, rgba) => {
      if (rows) for (let c = 0; c < 3; c++) planes[c].set(rows[c], top * width);
      data.set(rgba, top * width * 4);
    });
  } catch { return decodeBands(bytes, options); }
  return decodeImage(bytes, options, () => bandFrame(h, f, planes, data, format));
}
