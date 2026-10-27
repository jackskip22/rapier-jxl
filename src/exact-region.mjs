// SPDX-License-Identifier: MIT
import {reconstruct} from './reconstruct.mjs';
import {butteraugli, butteraugliReference} from './butteraugli.mjs';
import {exactPow} from './exact-math.mjs';
import {SRGB_TO_LINEAR} from './ssimulacra2.mjs';
import {butteraugliBytes, memoryPlan, poolWorkers} from './memory-plan.mjs';
import {fault} from './fault.mjs';
import {spawnJxlHelper} from './worker-assets.mjs';
import {validateWorkerReservation, claimWorkerReservation, workerBackingBytes} from './worker-reservation.mjs';
import {cellSums, xybStrategies} from './varblocks.mjs';
import {TRANSFORMS} from './vardct-strategies.mjs';
import {blockDistances} from './aq.mjs';

export const CROP_MARGIN = 80;
const CELL = 8, RECON_MARGIN = 8;

export function subBase(base, bx0, by0, bx1, by1) {
  const sliced = sliceBlocks(base, bx0, by0, bx1, by1), W = base.components[0].stride * 8, w = (bx1 - bx0) * 8;
  sliced.planes = base.planes.map(p => { const o = new p.constructor(w * (by1 - by0) * 8); for (let y = 0; y < (by1 - by0) * 8; y++) o.set(p.subarray((by0 * 8 + y) * W + bx0 * 8, (by0 * 8 + y) * W + bx0 * 8 + w), y * w); return o; });
  return sliced;
}

export function subImage(image, bx0, by0, bx1, by1) {
  const sub = sliceBlocks(image, bx0, by0, bx1, by1), sd = image.strategyData;
  if (!sd) return sub;
  const stride = bx1 - bx0, rows = by1 - by0, at = new Int32Array(stride * rows).fill(-1), blocks = [];
  for (const b of sd.blocks) if (b.bx >= bx0 && b.bx < bx1 && b.by >= by0 && b.by < by1) {
    const moved = {...b, bx: b.bx - bx0, by: b.by - by0};
    for (let y = 0; y < b.bh; y++) for (let x = 0; x < b.bw; x++) at[(moved.by + y) * stride + moved.bx + x] = blocks.length;
    blocks.push(moved);
  }
  sub.strategyData = {groups: [blocks], blocks, at, tables: sd.tables, stride};
  return sub;
}

function sliceBlocks(image, bx0, by0, bx1, by1) {
  const comps = image.components, stride = comps[0].stride, sw = bx1 - bx0, sh = by1 - by0, n = sw * sh;
  const rows = (arr, per) => {
    const o = ArrayBuffer.isView(arr) ? new arr.constructor(n * per) : new Float64Array(n * per);
    for (let y = 0; y < sh; y++) {
      const from = ((by0 + y) * stride + bx0) * per;
      if (ArrayBuffer.isView(arr)) o.set(arr.subarray(from, from + sw * per), y * sw * per);
      else for (let x = 0; x < sw * per; x++) o[y * sw * per + x] = arr[from + x];
    }
    return o;
  };
  const cfl = image.cfl, tw = Math.ceil(sw / 8), th = Math.ceil(sh / 8), tiles = arr => { const o = new arr.constructor(tw * th); for (let y = 0; y < th; y++) o.set(arr.subarray((by0 / 8 + y) * cfl.width + bx0 / 8, (by0 / 8 + y) * cfl.width + bx0 / 8 + tw), y * tw); return o; };
  const {planes: _planes, values: _values, ...coded} = image;
  const width = Math.min(image.width, bx1 * 8) - bx0 * 8, height = Math.min(image.height, by1 * 8) - by0 * 8;
  let alpha = null;
  if (image.alpha) {
    alpha = new image.alpha.constructor(width * height * 4);
    for (let y = 0; y < height; y++) alpha.set(image.alpha.subarray(((by0 * 8 + y) * image.width + bx0 * 8) * 4, ((by0 * 8 + y) * image.width + bx0 * 8 + width) * 4), y * width * 4);
  }
  return {...coded, width, height, alpha,
    components: comps.map(c => ({...c, stride: sw, rows: sh, ...(c.coeffs?.length === stride * comps[0].rows * 64 ? {coeffs: rows(c.coeffs, 64)} : {}),
      ...(c.dc ? {dc: rows(c.dc, 1)} : {})})),
    quantFields: image.quantFields ? rows(image.quantFields, 1) : image.quantFields,
    ...(image.sharpness ? {sharpness: rows(image.sharpness, 1)} : {}), cfl: {...cfl, width: tw, x: tiles(cfl.x), b: tiles(cfl.b)}};
}

export function cropFor({x0, y0, x1, y1}, width, height, margin = CROP_MARGIN) {
  const cx0 = Math.max(0, x0 - margin) & ~(CELL - 1), cy0 = Math.max(0, y0 - margin) & ~(CELL - 1), cx1 = Math.min(width, x1 + margin), cy1 = Math.min(height, y1 + margin);
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8);
  const bx0 = Math.max(0, Math.floor((cx0 - RECON_MARGIN) / 64) * 8), by0 = Math.max(0, Math.floor((cy0 - RECON_MARGIN) / 64) * 8);
  const bx1 = Math.min(stride, Math.ceil((cx1 + RECON_MARGIN) / 64) * 8), by1 = Math.min(rows, Math.ceil((cy1 + RECON_MARGIN) / 64) * 8);
  return {crop: {x0: cx0, y0: cy0, x1: cx1, y1: cy1}, blocks: {bx0, by0, bx1, by1}};
}

export function regionMeasure(reference, width, height, imageOf, region, {p = 3, margin = 2, refCache = null} = {}) {
  const job = regionJob(reference, width, height, region, {margin}), key = `${job.crop.x0},${job.crop.y0},${job.crop.x1},${job.crop.y1}`;
  let ref = refCache?.get(key);
  if (!ref) { ref = butteraugliReference(job.refPlanes, job.crop.x1 - job.crop.x0, job.crop.y1 - job.crop.y0); refCache?.set(key, ref); }
  return measureSub(ref, imageOf(job.blocks.bx0, job.blocks.by0, job.blocks.bx1, job.blocks.by1), job, {p, margin});
}

export function regionJob(reference, width, height, region, {margin = 2} = {}) {
  if (!Number.isSafeInteger(margin) || margin < 0) throw new RangeError('Exact region margin must be a nonnegative integer.');
  const {crop, blocks} = cropFor(region, width, height, Math.max(CROP_MARGIN, Math.ceil((75 + margin) / 8) * 8));
  return {region, crop, blocks, refPlanes: cutReference(reference, width, crop), width, height};
}
export function cutReference(reference, width, crop) {
  const cw = crop.x1 - crop.x0, ch = crop.y1 - crop.y0;
  if (reference.rgba) {
    const planes = [0, 1, 2].map(() => new Float64Array(cw * ch));
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const source = ((crop.y0 + y) * width + crop.x0 + x) * 4, at = y * cw + x;
      for (let c = 0; c < 3; c++) planes[c][at] = SRGB_TO_LINEAR[reference.rgba[source + c]];
    }
    return planes;
  }
  return reference.map(pl => { const o = new Float64Array(cw * ch); for (let y = 0; y < ch; y++) o.set(pl.subarray((crop.y0 + y) * width + crop.x0, (crop.y0 + y) * width + crop.x1), y * cw); return o; });
}

export function measureSub(ref, sub, {region, crop, blocks: b, width, height}, {p = 3, margin = 2} = {}) {
  const stride = Math.ceil(width / 8), lin = reconstruct(sub), sw = sub.width;
  const cw = crop.x1 - crop.x0, ch = crop.y1 - crop.y0, ox = crop.x0 - b.bx0 * 8, oy = crop.y0 - b.by0 * 8;
  const dist = lin.map(pl => { const o = new Float64Array(cw * ch); for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) o[y * cw + x] = pl[(oy + y) * sw + ox + x]; return o; });
  const map = butteraugli(ref, dist).map, cells = new Map(), distances = new Map();
  for (let by = region.y0 >> 3; by < Math.ceil(Math.min(height, region.y1) / 8); by++) for (let bx = region.x0 >> 3; bx < Math.ceil(Math.min(width, region.x1) / 8); bx++) {
    let s = 0, m = 0;
    for (let y = by * 8; y < Math.min(height, by * 8 + 8); y++) for (let x = bx * 8; x < Math.min(width, bx * 8 + 8); x++) s += exactPow(map[(y - crop.y0) * cw + x - crop.x0], p);
    for (let y = Math.max(0, by * 8 - margin); y < Math.min(height, by * 8 + 8 + margin); y++)
      for (let x = Math.max(0, bx * 8 - margin); x < Math.min(width, bx * 8 + 8 + margin); x++) m = Math.max(m, map[(y - crop.y0) * cw + x - crop.x0]);
    cells.set(by * stride + bx, s); distances.set(by * stride + bx, m);
  }
  return {cells, blocks: distances};
}

export function runJob({job, ids, options, subBase: base, sub, p, margin}) {
  const ref = butteraugliReference(job.refPlanes, job.crop.x1 - job.crop.x0, job.crop.y1 - job.crop.y0), out = [];
  for (const id of ids ?? [null]) {
    const image = sub ?? xybStrategies(base, base.width, base.height, {...options, force: id, maps: null}).image;
    const r = measureSub(ref, image, job, {p, margin});
    out.push([id, [...r.cells], [...r.blocks]]);
  }
  return out;
}

const previewBytes = Symbol('exact cropped payload bytes');
const sized = bytes => ({[previewBytes]: bytes});
export function exactPayloadBytes(value) {
  const objects = new Set(); let bytes;
  try { bytes = workerBackingBytes(value); }
  catch (error) { throw Object.assign(fault('JXL_MEMORY', 'Exact payload must contain owned cloneable data.'), {cause: error}); }
  const add = n => { bytes += n; if (!Number.isSafeInteger(bytes)) throw fault('JXL_MEMORY', 'Exact payload byte count overflowed.'); };
  const visit = v => {
    if (v === null || v === undefined) return;
    if (typeof v === 'number') { add(8); return; }
    if (typeof v === 'boolean') { add(1); return; }
    if (typeof v === 'string') { add(v.length * 2); return; }
    if (typeof v !== 'object') throw fault('JXL_MEMORY', 'Exact payload contains an unsupported value.');
    if (objects.has(v)) return; objects.add(v);
    if (v[previewBytes] !== undefined) { add(v[previewBytes]); return; }
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return;
    if (v instanceof Map) { for (const [key, item] of Map.prototype.entries.call(v)) { visit(key); visit(item); } return; }
    if (v instanceof Set) { for (const item of Set.prototype.values.call(v)) visit(item); return; }
    if (Array.isArray(v)) { for (const item of v) visit(item); return; }
    for (const [key, item] of Object.entries(v)) { add(key.length * 2); visit(item); }
  };
  visit(value); return bytes;
}

function exactReservation(size, reservation) {
  try { reservation = validateWorkerReservation(reservation); }
  catch (error) { throw Object.assign(fault('JXL_MEMORY', 'Exact workers require a complete shared worker reservation.'), {cause: error}); }
  if (size > reservation.count) throw fault('JXL_MEMORY', 'Exact worker count exceeds its shared reservation.');
  return reservation;
}

export function exactJobBytes(message) {
  const {job, sub} = message;
  if (!job || !sub || message.subBase || message.ids) throw fault('JXL_MEMORY', 'This exact job has no admitted reconstruction bound.');
  const cw = job.crop.x1 - job.crop.x0, ch = job.crop.y1 - job.crop.y0, b = job.blocks;
  const sw = b.bx1 - b.bx0, sh = b.by1 - b.by0, q = sw * sh * 64;
  const r = job.region;
  if (![job.width, job.height].every(v => Number.isSafeInteger(v) && v > 0) ||
      !Object.values(b).every(v => Number.isSafeInteger(v) && v >= 0) ||
      ![r.x0, r.y0, r.x1, r.y1].every(Number.isSafeInteger) || r.x0 < 0 || r.y0 < 0 || r.x1 < r.x0 || r.y1 < r.y0 ||
      r.x1 > job.width || r.y1 > job.height)
    throw fault('JXL_MEMORY', 'Exact job has invalid picture or region geometry.');
  if (![cw, ch, q].every(v => Number.isSafeInteger(v) && v > 0) || cw * ch > 224 * 224 || q > 320 * 320)
    throw fault('JXL_MEMORY', 'Exact job exceeds its admitted crop geometry.');
  if (!Array.isArray(sub.components) || sub.components.length !== 3 ||
      sub.components.some(c => c.stride !== sw || c.rows !== sh) ||
      !Number.isSafeInteger(sub.width) || sub.width < 1 || sub.width > sw * 8 ||
      !Number.isSafeInteger(sub.height) || sub.height < 1 || sub.height > sh * 8)
    throw fault('JXL_MEMORY', 'Exact image dimensions do not match its reserved crop.');
  if (sub.strategyData && (!Array.isArray(sub.strategyData.blocks) || sub.strategyData.blocks.length > sw * sh || sub.strategyData.blocks.some(block => {
      const transform = TRANSFORMS[block.id];
      return ![block.bx, block.by, block.bw, block.bh].every(Number.isSafeInteger) || block.bx < 0 || block.by < 0 ||
        block.bw < 1 || block.bh < 1 || block.bw > 8 || block.bh > 8 || block.bx + block.bw > sw || block.by + block.bh > sh ||
        block.area !== block.bw * block.bh || block.size !== 64 * block.area || !transform ||
        transform.width !== 8 * block.bw || transform.height !== 8 * block.bh || block.order?.length !== block.size ||
        !Array.isArray(block.coeffs) || block.coeffs.length !== 3 || block.coeffs.some(plane => plane.length !== block.size);
    })))
    throw fault('JXL_MEMORY', 'Exact transform geometry exceeds its reconstruction bound.');
  if (job.refPlanes?.[previewBytes] === undefined && (!Array.isArray(job.refPlanes) || job.refPlanes.length !== 3 ||
      job.refPlanes.some(plane => !(plane instanceof Float64Array) || plane.length !== cw * ch)))
    throw fault('JXL_MEMORY', 'Exact reference planes do not match the crop.');
  const ba = butteraugliBytes(cw, ch), reconstruction = 28 * q + 8 * (q / 64) + 2 * 256 * 256 * 8;
  const workBytes = ba.reference + Math.max(ba.work, reconstruction, 12 * q + 24 * cw * ch + ba.work);
  const cells = (Math.ceil(Math.min(job.width, r.x1) / 8) - (r.x0 >> 3)) *
    (Math.ceil(Math.min(job.height, r.y1) / 8) - (r.y0 >> 3));
  if (!Number.isSafeInteger(cells) || cells < 0) throw fault('JXL_MEMORY', 'Exact region has invalid cell geometry.');
  const inputBytes = exactPayloadBytes({...message, pool: 'exact', id: 0}), outputBytes = 8 + 32 * cells;
  const jobBytes = 2 * inputBytes + 2 * outputBytes + workBytes;
  if (!Number.isSafeInteger(jobBytes)) throw fault('JXL_MEMORY', 'Exact job byte count overflowed.');
  return {inputBytes, outputBytes, workBytes, jobBytes};
}
function admittedJob(message, reservation) {
  const bytes = exactJobBytes(message);
  if (bytes.inputBytes > reservation.inputBytes || bytes.outputBytes > reservation.outputBytes ||
      bytes.jobBytes + reservation.scratchBytes > reservation.jobBytes)
    throw fault('JXL_MEMORY', 'Exact job exceeds its input, result or working-memory reservation.');
  return bytes;
}

function previewSub(image, {bx0, by0, bx1, by1}) {
  const stride = image.components[0].stride, sw = bx1 - bx0, sh = by1 - by0, n = sw * sh;
  const bytes = (array, length) => sized(length * (array?.BYTES_PER_ELEMENT ?? 8));
  const {planes: _planes, values: _values, ...coded} = image;
  const width = Math.min(image.width, bx1 * 8) - bx0 * 8, height = Math.min(image.height, by1 * 8) - by0 * 8;
  const cfl = image.cfl, tw = Math.ceil(sw / 8), th = Math.ceil(sh / 8);
  const sub = {...coded, width, height, alpha: image.alpha ? bytes(image.alpha, width * height * 4) : null,
    components: image.components.map(c => ({...c, stride: sw, rows: sh,
      ...(c.coeffs?.length === stride * image.components[0].rows * 64 ? {coeffs: bytes(c.coeffs, n * 64)} : {}),
      ...(c.dc ? {dc: bytes(c.dc, n)} : {})})),
    quantFields: image.quantFields ? bytes(image.quantFields, n) : image.quantFields,
    ...(image.sharpness ? {sharpness: bytes(image.sharpness, n)} : {}),
    cfl: {...cfl, width: tw, x: bytes(cfl.x, tw * th), b: bytes(cfl.b, tw * th)}};
  if (image.strategyData) {
    const blocks = [];
    for (const block of image.strategyData.blocks) if (block.bx >= bx0 && block.bx < bx1 && block.by >= by0 && block.by < by1) {
      if (block.bw > 8 || block.bh > 8 || block.bx + block.bw > bx1 || block.by + block.bh > by1)
        throw fault('JXL_MEMORY', 'Exact crop cannot bound this transform geometry.');
      blocks.push({...block, bx: block.bx - bx0, by: block.by - by0});
    }
    sub.strategyData = {groups: [blocks], blocks, at: sized(n * 4), tables: image.strategyData.tables, stride: sw};
  }
  return sub;
}

const abortError = signal => signal?.aborted ? signal.reason : Object.assign(new Error('Exact workers were canceled.'), {name: 'AbortError'});

export async function exactPool(size = poolSize(), {spawn = spawnJxlHelper, signal, reservation} = {}) {
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('Exact worker count must be a nonnegative integer.');
  if (size === 0) return null;
  if (signal?.aborted) throw abortError(signal);
  exactReservation(size, reservation);
  const admission = claimWorkerReservation(reservation, spawn, 'exact');
  reservation = admission.reservation;
  const workers = [], idle = [], pending = new Map(), dead = new Set();
  const retirements = [];
  let next = 0, closed = false, retirement = null;
  const remember = stopped => { stopped.catch(() => {}); retirements.push(stopped); };
  const retire = (worker, error) => {
    if (dead.has(worker)) return;
    dead.add(worker);
    let stopped; try { stopped = Promise.resolve(worker.terminate()); } catch (failure) { stopped = Promise.reject(failure); }
    remember(stopped);
    for (const key of ['onmessage', 'onerror', 'onmessageerror']) {
      try { worker[key] = null; } catch (failure) { remember(Promise.reject(failure)); }
    }
    const at = idle.indexOf(worker); if (at >= 0) idle.splice(at, 1);
    for (const [id, job] of pending) if (job.worker === worker) { pending.delete(id); job.reject(error); }
  };
  const terminate = (error = abortError(signal)) => {
    if (!closed) {
      closed = true;
      try { signal?.removeEventListener('abort', onAbort); } catch (failure) { remember(Promise.reject(failure)); }
      for (const worker of workers) retire(worker, error);
      idle.length = 0;
    }
    if (!retirement) {
      retirement = Promise.resolve().then(() => Promise.allSettled(retirements)).then(results => {
        const failed = results.find(result => result.status === 'rejected');
        if (failed) { admission.fail(failed.reason); throw failed.reason; }
        admission.release();
      });
      retirement.catch(() => {});
    }
    return retirement;
  };
  const onAbort = () => { terminate(abortError(signal)).catch(() => {}); };
  try {
    for (let i = 0; i < size; i++) {
      const worker = spawn(); if (!worker) throw new Error('Exact worker is unavailable.'); workers.push(worker); idle.push(worker);
      if (signal?.aborted) throw abortError(signal);
    }
    for (const worker of workers) {
      worker.onmessage = ({data}) => {
        if (closed || dead.has(worker)) return;
        const job = pending.get(data?.id);
        if (data?.pool !== 'exact' || !job || job.worker !== worker) { retire(worker, new Error('Invalid exact worker reply.')); return; }
        const errorReply = Object.hasOwn(data, 'error');
        try {
          if (errorReply && (!data.error || typeof data.error !== 'object' || typeof data.error.message !== 'string' ||
              (data.error.name !== undefined && typeof data.error.name !== 'string') ||
              (data.error.code !== undefined && typeof data.error.code !== 'string'))) throw new Error('Invalid exact worker error.');
          if (!errorReply && !Object.hasOwn(data, 'result')) throw new Error('Invalid exact worker result.');
          if (exactPayloadBytes(errorReply ? data.error : data.result) > reservation.outputBytes)
            throw fault('JXL_MEMORY', 'Exact worker result exceeds its reservation.');
        } catch (error) { retire(worker, error); return; }
        pending.delete(data.id); idle.push(worker);
        if (errorReply) {
          const error = new Error(data.error.message); error.name = data.error.name ?? 'Error';
          if (data.error.code !== undefined) error.code = data.error.code;
          job.reject(error);
        } else job.resolve(data.result);
      };
      worker.onerror = e => retire(worker, e.error ?? new Error(e.message ?? 'Exact worker failed.'));
      worker.onmessageerror = () => retire(worker, new Error('Invalid exact worker message.'));
    }
    signal?.addEventListener('abort', onAbort, {once: true});
    if (signal?.aborted) throw abortError(signal);
  } catch (error) {
    let cleanup, failed = false;
    try { await terminate(error); } catch (failure) { cleanup = failure; failed = true; }
    if (signal?.aborted) throw abortError(signal);
    if (error?.code === 'JXL_MEMORY' || error?.code === 'JXL_WORKER_LEASE') throw error;
    if (failed) throw cleanup;
    return null;
  }
  return {
    reservation, signal,
    get size() { return closed ? 0 : workers.length - dead.size; },
    run: message => new Promise((resolve, reject) => {
      if (closed || signal?.aborted) { reject(abortError(signal)); return; }
      try { admission.check(); } catch (error) { reject(error); return; }
      if (!idle.length) { reject(fault('JXL_MEMORY', 'Exact worker capacity is already reserved by live jobs.')); return; }
      try { admittedJob(message, reservation); } catch (error) { reject(error); return; }
      const worker = idle.pop(), id = next++;
      pending.set(id, {resolve, reject, worker});
      try { worker.postMessage({...message, pool: 'exact', id}); }
      catch (error) { retire(worker, error); }
    }),
    terminate,
  };
}

export function exactAnswerer(rgba, width, height, pool = null, reference = null, workers = poolSize(width * height, undefined, {width, height}), memory = null, wholeMeasure = null, signal = pool?.signal) {
  if (!Number.isSafeInteger(workers) || workers < 0) throw new RangeError('Exact worker count must be a nonnegative integer.');
  let own = null, small = null, destroyed = false, busy = false, retirement = null;
  const plan = memory ?? memoryPlan(width * height, {width, height});
  let activePool = workers > 0 ? pool : null;
  const retirePool = () => {
    if (activePool) {
      const retiring = activePool; activePool = null;
      try { retirement = Promise.resolve(retiring.terminate?.()); } catch (error) { retirement = Promise.reject(error); }
      retirement.catch(() => {});
    }
    return retirement ?? Promise.resolve();
  };
  let lin = typeof reference === 'function' ? reference : (() => own ??= {rgba});
  const withReference = consume => typeof reference?.withReference === 'function' ? reference.withReference(consume) : consume(lin());
  const wholeMap = image => butteraugli(small ??= butteraugliReference(withReference(ref => cutReference(ref, width, {x0: 0, y0: 0, x1: width, y1: height})), width, height), reconstruct(image)).map;
  const answer = async request => {
    if (signal?.aborted) throw signal.reason;
    if (destroyed) throw Object.assign(new Error('Exact answerer is closed.'), {name: 'AbortError'});
    if (busy) throw fault('JXL_MEMORY', 'Exact requests must run sequentially.');
    busy = true;
    try {
    const {p = 3, margin = 2} = request;
    if (!Number.isSafeInteger(margin) || margin < 0) throw new RangeError('Exact block margin must be a nonnegative integer.');
    const measured = image => {
      if (wholeMeasure) { const {cells, blocks} = wholeMeasure(image, {p, margin, ssimulacra2: false}); return {whole: true, cells, blocks}; }
      if (plan.banded) { const {cells, blocks} = withReference(ref => bandedScores(ref, width, height, image, {p, margin, rows: plan.bandRows})); return {whole: true, cells, blocks}; }
      const map = wholeMap(image); return {whole: true, cells: cellSums(map, width, height, p), blocks: blockDistances({map, width, height}, margin)};
    };
    const afterRetirement = async run => {
      try { await retirePool(); }
      catch (error) { answer.retirementFailures++; if (signal?.aborted) throw signal.reason; throw error; }
      if (signal?.aborted) throw signal.reason;
      if (destroyed) throw Object.assign(new Error('Exact answerer is closed.'), {name: 'AbortError'});
      return run();
    };
    if (request.kind === 'whole') return await afterRetirement(() => measured(request.image));
    if (request.kind !== 'cells' && request.kind !== 'blocks') return null;
    if (!request.regions.length) return request.kind === 'cells' ? new Map() : {cells: new Map(), blocks: new Map()};
    const whole = () => {
      if (request.kind === 'blocks') return measured(request.image);
      const out = new Map();
      for (const id of request.ids) out.set(id, measured(xybStrategies(request.base, width, height, {...request.options, force: id, maps: null}).image));
      return out;
    };
    if (!activePool || activePool.size === 0 || request.kind === 'cells') return await afterRetirement(whole);
    const reservation = exactReservation(Math.min(workers, activePool.size), activePool.reservation ?? plan.workerReservation);
    const regions = mergeRegions(request.regions, width, height);
    const cropLimit = Math.min(plan.workerCropPixels ?? 224 * 224, 224 * 224), blockLimit = Math.min(plan.workerBlockPixels ?? 320 * 320, 320 * 320);
    const oversized = regions.some(region => {
      const {crop, blocks: b} = cropFor(region, width, height, Math.max(CROP_MARGIN, Math.ceil((75 + margin) / 8) * 8));
      return (crop.x1 - crop.x0) * (crop.y1 - crop.y0) > cropLimit || (b.bx1 - b.bx0) * (b.by1 - b.by0) * 64 > blockLimit;
    });
    if (oversized || cropsCost(regions, width, height, activePool ? Math.min(workers, activePool.size ?? workers) : 0, margin) > WHOLE_COST * width * height) {
      return await afterRetirement(whole);
    }
    try {
      for (const region of regions) {
        const geometry = cropFor(region, width, height, Math.max(CROP_MARGIN, Math.ceil((75 + margin) / 8) * 8));
        const crop = geometry.crop, job = {...geometry, region, width, height,
          refPlanes: sized(24 * (crop.x1 - crop.x0) * (crop.y1 - crop.y0))};
        admittedJob({job, sub: previewSub(request.image, geometry.blocks), p, margin}, reservation);
      }
    } catch (error) { if (error.code === 'JXL_MEMORY') return await afterRetirement(whole); throw error; }
    const message = region => {
      const job = withReference(ref => regionJob(ref, width, height, region, {margin})), {bx0, by0, bx1, by1} = job.blocks;
      return request.kind === 'cells' ? {job, ids: request.ids, options: request.options, subBase: subBase(request.base, bx0, by0, bx1, by1), p, margin}
        : {job, sub: subImage(request.image, bx0, by0, bx1, by1), p, margin};
    };
    const lanes = Math.max(1, Math.min(workers, activePool.size ?? workers)), out = new Map();
    for (let at = 0; at < regions.length; at += lanes) {
      const pending = []; let failure, failed = false, workerFailure = false;
      try {
        const runningPool = activePool;
        for (let k = at; k < Math.min(regions.length, at + lanes); k++) {
          const m = message(regions[k]);
          pending.push(Promise.resolve().then(() => runningPool.run(m)).catch(error => { workerFailure = true; throw error; }));
        }
        const results = await Promise.all(pending);
        if (destroyed) throw Object.assign(new Error('Exact answerer is closed.'), {name: 'AbortError'});
        for (const rows of results) for (const [id, cells, blocks] of rows) {
          const into = out.get(id) ?? out.set(id, {cells: new Map(), blocks: new Map()}).get(id);
          for (const [k, v] of cells) into.cells.set(k, v); for (const [k, v] of blocks) into.blocks.set(k, v);
        }
      } catch (error) { failure = error; failed = true; }
      if (failed) {
        let retirementFailed = false;
        try { await retirePool(); } catch { retirementFailed = true; answer.retirementFailures++; }
        await Promise.allSettled(pending); pending.length = 0; activePool = null; out.clear();
        if (signal?.aborted) throw signal.reason;
        if (retirementFailed || destroyed || failure?.name === 'AbortError' || failure?.code === 'JXL_MEMORY' ||
            failure?.code === 'JXL_WORKER_LEASE' || !workerFailure) throw failure;
        answer.fallbacks++; failure = null;
        return whole();
      }
    }
    return request.kind === 'cells' ? out : out.get(null) ?? {cells: new Map(), blocks: new Map()};
    } finally { busy = false; }
  };
  answer.fallbacks = 0; answer.retirementFailures = 0;
  answer.destroy = () => {
    destroyed = true;
    const stopped = retirePool();
    own = small = lin = activePool = rgba = reference = pool = wholeMeasure = null;
    return Promise.resolve(stopped);
  };
  return answer;
}

export function mergeRegions(regions, width, height) {
  const tiles = new Map();
  for (const r of regions) {
    const key = Math.floor(r.y0 / 64) * 65536 + Math.floor(r.x0 / 64), t = tiles.get(key);
    if (!t) tiles.set(key, {...r});
    else { t.x0 = Math.min(t.x0, r.x0); t.y0 = Math.min(t.y0, r.y0); t.x1 = Math.max(t.x1, r.x1); t.y1 = Math.max(t.y1, r.y1); }
  }
  return [...tiles.values()].map(t => ({x0: t.x0, y0: t.y0, x1: Math.min(width, t.x1), y1: Math.min(height, t.y1)}));
}

export function poolSize(pixels = 0, cores = globalThis.navigator?.hardwareConcurrency ?? 2, options = {}) {
  return poolWorkers(pixels, cores, options);
}

export const BAND_ROWS = 128;

function eachBand(reference, width, height, image, rows, consume) {
  if (!Number.isSafeInteger(rows) || rows < 1) throw new RangeError('Exact band rows must be a positive integer.');
  for (let y0 = 0; y0 < height; y0 += rows) {
    const region = {x0: 0, y0, x1: width, y1: Math.min(height, y0 + rows)}, job = regionJob(reference, width, height, region), {crop, blocks: b} = job;
    const cw = crop.x1 - crop.x0, ch = crop.y1 - crop.y0, sub = subImage(image, b.bx0, b.by0, b.bx1, b.by1), lin = reconstruct(sub), sw = sub.width;
    const ox = crop.x0 - b.bx0 * 8, oy = crop.y0 - b.by0 * 8;
    const dist = lin.map(pl => { const o = new Float64Array(cw * ch); for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) o[y * cw + x] = pl[(oy + y) * sw + ox + x]; return o; });
    const map = butteraugli(butteraugliReference(job.refPlanes, cw, ch), dist).map;
    consume(map, crop, region);
  }
}

export function bandedMap(reference, width, height, image, rows = BAND_ROWS) {
  const map = new Float64Array(width * height);
  eachBand(reference, width, height, image, rows, (band, crop, region) => {
    for (let y = region.y0; y < region.y1; y++) map.set(band.subarray((y - crop.y0) * width, (y - crop.y0 + 1) * width), y * width);
  });
  return map;
}

export function bandedScores(reference, width, height, image, {p = 3, margin = 2, rows = BAND_ROWS} = {}) {
  if (!Number.isSafeInteger(margin) || margin < 0) throw new RangeError('Exact block margin must be a nonnegative integer.');
  const stride = Math.ceil(width / 8), count = Math.ceil(height / 8), cells = new Float64Array(stride * count), blocks = new Float64Array(stride * count);
  const sums = [0, 0, 0]; let max = 0;
  eachBand(reference, width, height, image, rows, (map, crop, region) => {
    for (let y = region.y0; y < region.y1; y++) {
      const by0 = Math.max(0, Math.ceil((y - margin - 7) / 8)), by1 = Math.min(count - 1, Math.floor((y + margin) / 8));
      for (let x = 0; x < width; x++) {
        const v = map[(y - crop.y0) * width + x]; max = Math.max(max, v);
        let d = v * (v * v); sums[0] += d; d *= d; sums[1] += d; d *= d; sums[2] += d;
        cells[(y >> 3) * stride + (x >> 3)] += exactPow(v, p);
        const bx0 = Math.max(0, Math.ceil((x - margin - 7) / 8)), bx1 = Math.min(stride - 1, Math.floor((x + margin) / 8));
        for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
          const at = by * stride + bx; blocks[at] = Math.max(blocks[at], v);
        }
      }
    }
  });
  const butteraugli3 = sums.reduce((a, sum, k) => a + exactPow(sum / (width * height), 1 / (3 * (1 << k))), 0) / 3;
  return {butteraugli: max, butteraugli3, cells, blocks};
}

export function exactScores(cpu, reference, width, height, image, want = {}, memory = cpu.memory ?? null) {
  const plan = memory ?? memoryPlan(width * height, {width, height});
  if (!plan.banded || want.butteraugli === false) return cpu(image, want);
  if (typeof cpu.banded !== 'function') throw fault('JXL_INPUT', 'Banded scoring requires the CPU reference transaction.');
  return cpu.banded(image, want, ref => bandedScores(ref, width, height, image, {...want, rows: plan.bandRows}));
}

export const CROP_COST = 15, WHOLE_COST = 18;
export function cropsCost(regions, width, height, workers, margin = 2) {
  let pixels = 0;
  for (const region of regions) { const {crop} = cropFor(region, width, height, Math.max(CROP_MARGIN, Math.ceil((75 + margin) / 8) * 8)); pixels += (crop.x1 - crop.x0) * (crop.y1 - crop.y0); }
  return CROP_COST * pixels / Math.max(1, workers);
}

