// SPDX-License-Identifier: MIT
import {xybStrategies, auditCosts, strategyRowsLayout} from './varblocks.mjs';
import {unit, journaling} from './step-journal.mjs';
import {offloading, offloadWorkers} from './offload.mjs';
import {perceptualMaskField, maskWeights} from './photo-mask.mjs';
import {trialDue, tryStage, leftDevice} from './device-trial.mjs';
import {traced, tracing} from './stage-trace.mjs';
import {planeRequest, planeMessage, planeLayoutSteps} from './photo-plane-levels.mjs';
export {plainLayout, planeRequest, planeLevelsSteps, planeLayoutSteps} from './photo-plane-levels.mjs';
const check = signal => { if (signal?.aborted) throw signal.reason; };
const maskOf = base => base.maskWeight ?? (base.devicePlanes ? (base.devicePlanes.maskWeight ??= perceptualMaskField(base.planes, base.components[0].stride, base.components[0].rows,
  base.planeRows ? by => base.planeRows(by * 8, by * 8 + 8) : undefined).weight) : perceptualMaskField(base.planes, base.components[0].stride, base.components[0].rows,
  base.planeRows ? by => base.planeRows(by * 8, by * 8 + 8) : undefined).weight);

export function* planeSearchSteps(base, width, height, options, signal, layoutOnly = false) {
  if (leftDevice('photo-block-costs', width * height))
    return layoutOnly ? {layout: yield* planeSearchLayoutSteps(base, width, height, options, signal)} : xybStrategies(base, width, height, {...options, maskWeight: options.maskWeight ?? maskOf(base), priceOnly: true, keepChosen: true});
  const search = {...options, maskWeight: options.maskWeight ?? maskOf(base)}, request = planeRequest(base, width, height, search);
  const ask = {gpu: planeMessage(request, {kind: 'photo-block-costs', audit: answer => auditCosts(base, width, height, search, answer)})};
  if (trialDue('photo-block-costs', width * height)) {
    const searched = yield* tryStage('photo-block-costs', width * height, ask, function* () {
      return layoutOnly ? {layout: yield* planeSearchLayoutSteps(base, width, height, options, signal)}
        : xybStrategies(base, width, height, {...search, priceOnly: true, keepChosen: true});
    }, {estimate: () => costsSlice(base, width, height, search), keep: priced => fromPriced(priced)});
    check(signal);
    return searched;
  }
  return yield* fromPriced(yield ask);
  function* fromPriced(priced) {
    check(signal);
    if (priced?.costs?.certified) {
      const chosen = xybStrategies(base, width, height, {...search, costs: priced.costs, costDoubt: priced.weightDoubt || 0, chooseOnly: true});
      if (layoutOnly) return {layout: chosen.open.length ? yield* planeSearchLayoutSteps(base, width, height, options, signal) : chosen.layout};
      const layout = chosen.open.length ? xybStrategies(base, width, height, {...search, priceOnly: true, chooseOnly: true}).layout : chosen.layout;
      return {image: yield* planeLayoutSteps(base, width, height, layout, search, signal), layout};
    }
    if (layoutOnly) return {layout: yield* planeSearchLayoutSteps(base, width, height, options, signal)};
    return xybStrategies(base, width, height, {...search, priceOnly: true, keepChosen: true});
  }
}
function costsSlice(base, width, height, search) {
  const rows = base.components[0].rows;
  if (rows < 64) return null;
  const t0 = performance.now();
  let ms = 0;
  for (let by = 0; by < 16; by += 8) {
    const t = performance.now();
    xybStrategies(base, width, height, {...search, priceOnly: true, chooseOnly: true, regionRows: [by, by + 8]});
    ms = (performance.now() - t) * rows / 8;
  }
  if (tracing()) traced('trial:photo-block-costs:slice', performance.now() - t0);
  return ms;
}
export function* planeSearchLayoutSteps(base, width, height, options, signal) {
  const rows = base.components[0].rows, bands = [];
  const canOffload = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ === 'undefined' || !__RAPIER_JXL_CAPTURE_PHOTO__) &&
    (typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || !__RAPIER_JXL_UPLOAD__) && !journaling() && offloading('score-band');
  const count = Math.ceil(rows / 32), maskAhead = canOffload ? Math.min(count, offloadWorkers()) : 1;
  const ahead = canOffload ? Math.min(count - 1, maskAhead) : 0;
  const sharedPlanes = typeof SharedArrayBuffer === 'function' && base.planes?.[0]?.buffer instanceof SharedArrayBuffer ? base.planes : null;
  const sourceRgba = !sharedPlanes && base.sourceRgba && base.rowsRecipe ? base.sourceRgba : null;
  let computedMask = options.maskWeight ?? base.maskWeight ?? base.devicePlanes?.maskWeight ?? null;
  if (!computedMask && maskAhead > 1 && sourceRgba && !options.maps && !options.costs && !options.transforms) {
    const stride = base.components[0].stride, srcCap = 4 * width * Math.min(height, 416);
    const inputBytes = Math.ceil((srcCap + 65536) / 16) * 16;
    const free = Array.from({length: maskAhead}, () => new ArrayBuffer(inputBytes)), tasks = new Map(), look = {};
    const hf = new Float64Array(stride * rows);
    const makeMask = k => {
      const by0 = k * 32, by1 = Math.min(rows, by0 + 32), input = free.pop();
      let at = srcCap;
      const alloc = (Type, src) => {
        const sz = Type.BYTES_PER_ELEMENT;
        at = Math.ceil(at / sz) * sz;
        const out = new Type(input, at, src.length); out.set(src); at += src.length * sz; return out;
      };
      const copyVal = (v, seen = new Map()) => {
        if (ArrayBuffer.isView(v)) { let o = seen.get(v); if (!o) { o = alloc(v instanceof Uint8Array ? Uint8Array : v.constructor, v); seen.set(v, o); } return o; }
        return Array.isArray(v) ? v.map(e => copyVal(e, seen)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([key, e]) => [key, copyVal(e, seen)])) : v;
      };
      const top = Math.max(0, by0 * 8 - 64), end = Math.min(height, by1 * 8 + 96);
      const rowsBuf = new Uint8Array(input, 0, (end - top) * width * 4);
      rowsBuf.set(sourceRgba.subarray(top * width * 4, end * width * 4));
      const task = {kind: 'mask-band', look, input, inputBytes, rows: rowsBuf, top, width, height, stride, by0, by1, gaborish: copyVal(base.rowsRecipe)};
      tasks.set(k, task);
      return task;
    };
    let ok = true;
    try {
      yield {offload: 'prefetch', tasks: Array.from({length: maskAhead}, (_, k) => makeMask(k))};
      for (let k = 0; k < count; k++) {
        check(signal);
        const task = tasks.get(k) ?? makeMask(k);
        tasks.delete(k);
        const reply = yield {offload: 'run', task};
        if (reply?.hf instanceof Float64Array && reply.input instanceof ArrayBuffer && reply.input.byteLength === inputBytes) {
          free.push(reply.input);
          hf.set(reply.hf, task.by0 * stride);
        } else { ok = false; break; }
        if (k + maskAhead < count) yield {offload: 'prefetch', tasks: [makeMask(k + maskAhead)]};
      }
      if (ok) {
        computedMask = maskWeights(hf, stride, rows).weight;
        if (base.devicePlanes) base.devicePlanes.maskWeight = computedMask;
      }
    } finally { free.length = 0; tasks.clear(); }
  }
  const search = {...options, maskWeight: computedMask ?? maskOf(base)};
  if (ahead > 0 && (sharedPlanes || sourceRgba) && !search.maps && !search.costs && !search.transforms) {
    const stride = base.components[0].stride, srcCap = sharedPlanes ? 0 : 4 * width * Math.min(height, 416);
    const mw = search.maskWeight, qf = base.quantFields, cfl = base.cfl;
    const metaBytes = (mw ? mw.byteLength : 0) + (qf ? qf.byteLength : 0) + (cfl ? cfl.x.byteLength + cfl.b.byteLength : 0) + 65536;
    const inputBytes = Math.ceil((srcCap + metaBytes) / 16) * 16;
    const free = Array.from({length: ahead}, () => new ArrayBuffer(inputBytes)), tasks = new Map(), look = {};
    const {maskWeight: _m, ...plainOpts} = search;
    const makeTask = k => {
      const by0 = k * 32, by1 = Math.min(rows, by0 + 32), input = free.pop();
      let at = srcCap;
      const alloc = (Type, src) => {
        const sz = Type.BYTES_PER_ELEMENT;
        at = Math.ceil(at / sz) * sz;
        const out = new Type(input, at, src.length);
        out.set(src); at += src.length * sz;
        return out;
      };
      const copyVal = (v, seen = new Map()) => {
        if (ArrayBuffer.isView(v)) { let o = seen.get(v); if (!o) { o = alloc(v instanceof Uint8Array ? Uint8Array : v.constructor, v); seen.set(v, o); } return o; }
        return Array.isArray(v) ? v.map(e => copyVal(e, seen)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([ key, e ]) => [key, copyVal(e, seen)])) : v;
      };
      let rowsBuf = new Uint8Array(input, 0, 0), top = 0, sPlanes = null, planeTop = 0;
      if (sharedPlanes) {
        planeTop = by0 * 8;
        const pEnd = Math.min(rows * 8, by1 * 8 + 32);
        sPlanes = sharedPlanes.map(p => p.subarray(planeTop * stride * 8, pEnd * stride * 8));
      } else {
        top = Math.max(0, by0 * 8 - 64);
        const end = Math.min(height, by1 * 8 + 96);
        rowsBuf = new Uint8Array(input, 0, (end - top) * width * 4);
        rowsBuf.set(sourceRgba.subarray(top * width * 4, end * width * 4));
      }
      const task = {
        kind: 'shape-band', look, input, inputBytes, rows: rowsBuf, top, width, height, by0, by1,
        sharedPlanes: sPlanes, planeTop,
        gaborish: base.rowsRecipe ? copyVal(base.rowsRecipe) : null,
        base: {
          width: base.width, height: base.height, stride, fullRows: rows,
          quants: base.components.map(c => copyVal(c.quant)),
          quantScale: base.quantScale, epf: base.epf, xyb: base.xyb, ycbcr: base.ycbcr,
          quantFieldBase: base.quantFieldBase,
          quantFields: qf ? alloc(qf.constructor, qf) : null,
          cfl: cfl ? {width: cfl.width, x: alloc(cfl.x.constructor, cfl.x), b: alloc(cfl.b.constructor, cfl.b)} : null,
        },
        maskWeight: mw ? alloc(Float64Array, mw) : null,
        options: copyVal(plainOpts),
      };
      tasks.set(k, task);
      return task;
    };
    try {
      yield {offload: 'prefetch', tasks: Array.from({length: ahead}, (_, k) => makeTask(k))};
      for (let k = 0; k < count; k++) {
        check(signal);
        const turn = ahead + 1, own = k + ahead;
        if (k % turn === 0 && own < count)
          bands[own] = xybStrategies(base, width, height, {...search, priceOnly: true, chooseOnly: true, regionRows: [own * 32, Math.min(rows, (own + 1) * 32)]});
        if (k % turn === ahead) continue;
        const task = tasks.get(k) ?? makeTask(k);
        tasks.delete(k);
        const reply = yield {offload: 'run', task};
        if (reply?.chosen instanceof Int32Array && reply.input instanceof ArrayBuffer && reply.input.byteLength === inputBytes) {
          free.push(reply.input);
          bands[k] = {chosen: reply.chosen, useMask: reply.useMask, pruneRare: reply.pruneRare};
        } else {
          free.push(task.input.byteLength === inputBytes ? task.input : new ArrayBuffer(inputBytes));
          bands[k] = xybStrategies(base, width, height, {...search, priceOnly: true, chooseOnly: true, regionRows: [task.by0, task.by1]});
        }
        if (reply && k + turn < count) yield {offload: 'prefetch', tasks: [makeTask(k + turn)]};
      }
      return strategyRowsLayout(bands);
    } finally { free.length = 0; tasks.clear(); }
  }
  for (let by = 0; by < rows; by += 32) {
    check(signal);
    bands.push(yield* unit('shape-band', () => xybStrategies(base, width, height, {...search, priceOnly: true, chooseOnly: true, regionRows: [by, by + 32]})));
  }
  return strategyRowsLayout(bands);
}
