// SPDX-License-Identifier: BSD-3-Clause
/*!
 * Copyright (c) the JPEG XL Project Authors.
 * All rights reserved.
 * 
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 * 
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 * 
 * 3. Neither the name of the copyright holder nor the names of its
 *    contributors may be used to endorse or promote products derived from
 *    this software without specific prior written permission.
 * 
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
import {kernelModule} from './kernel-runtime.mjs';
import {fault} from './fault.mjs';
import {OPSIN, inverse, times} from './color-transform.mjs';
import {S2_MEMORY, s2ArenaPlan, ssimulacra2Layout} from './ssimulacra2-memory.mjs';
import {S2_FUSED} from './ssimulacra2-fused-bytes.mjs';
import {wasmBytes} from './wasm-text.mjs';
import {compileWasm, suppliedWasm, wasmModule} from './wasm-modules.mjs';
import {onCallEnd} from './call-scope.mjs';
export {ssimulacra2WorkBytes} from './ssimulacra2-memory.mjs';

const {linear:LUT, gaussian:GAUSS} = S2_MEMORY, TRANSFORM_AT = LUT - 24576, BAND_ROWS = 128;
let memory, kernel, lastTransform = null, lastGauss, views;

const PROBE = GAUSS + 176, FAILED = GAUSS + 240, USE_FUSED = GAUSS + 244, u = 1 + 2 ** -12;
const PROBE_INPUT = (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? null : [u, -u, 2 * u, u, u, u, u, -2 * u, -(1 + 2 ** -11), 1 + 2 ** -11, -(2 + 2 ** -10), 2 + 2 ** -10];
export const FUSED_PROBE = (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? null : Float32Array.from([...PROBE_INPUT, ...[0, 1, 2, 3].map(i => PROBE_INPUT[i] * PROBE_INPUT[4 + i] + PROBE_INPUT[8 + i])]);
let fusedState = 0, fusedAllowed = true;
const fusedBytes = (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? null : () => wasmBytes(S2_FUSED);
function fusedModule() {
  if (fusedState) return fusedState > 0 ? wasmModule('s2-fused', fusedBytes) : null;
  fusedState = -1;
  try {
    if (!fusedBytes || suppliedWasm() || !WebAssembly.validate(fusedBytes())) return null;
    const module = wasmModule('s2-fused', fusedBytes);
    fusedState = 1; return module;
  } catch { return null; }
}
let bandsFused = null;
export const bandsAtSpeed = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? null : function bandsAtSpeed() {
  const module = fusedAllowed ? fusedModule() : null;
  if (!module) return true;
  return bandsFused ??= WebAssembly.Module.exports(module).some(entry => entry.name === 's2FusedRow' || entry.name === 's2MetricBand');
};
export const compileFusedMetric = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? null : async function compileFusedMetric() {
  if (!fusedBytes || fusedState || suppliedWasm()) return;
  try { if (WebAssembly.validate(fusedBytes())) await compileWasm('s2-fused', fusedBytes); } catch {}
};
export const fusedMetric = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? null : function fusedMetric(allow = fusedAllowed) {
  fusedAllowed = allow;
  return allow && !!fusedModule();
};
const FUSED_OF = new WeakMap();
const fusedOf = () => FUSED_OF.get(kernel) ?? null;

const TRANSFORM_TABLES = new WeakMap();
export function transformTable(transform) {
  let entry = TRANSFORM_TABLES.get(transform);
  if (entry) return entry;
  const back = times(inverse(OPSIN), transform.lms), table = new Float64Array(3072);
  for (let k = 0; k < 3; k++) {
    const m0 = back[k], m1 = back[3 + k], m2 = back[6 + k], t = transform.tables[k];
    for (let i = 0; i < 256; i++) {
      const off = (k * 256 + i) * 4, v = t[i];
      table[off] = m0 * v; table[off + 1] = m1 * v; table[off + 2] = m2 * v;
    }
  }
  entry = {table, ok: table.every(v => Math.abs(v) < 1e30)};
  TRANSFORM_TABLES.set(transform, entry);
  return entry;
}

let base = S2_MEMORY.base, resident = null, dirtyEnd = base;
export function openMetricArena() {
  const previous = [memory,kernel,lastTransform,lastGauss,views,base,resident,dirtyEnd];
  const free = pooled.pop() ?? weak.pop()?.deref();
  [memory,kernel,lastGauss,lastTransform,views] = free ? [free.memory,free.kernel,free.lastGauss,free.lastTransform ?? null,free.views] : [undefined,undefined,undefined,null,undefined];
  resident = null; base = dirtyEnd = S2_MEMORY.base;
  if (memory) { refreshViews(); armProbe(); }
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    try { if (memory) { clearProbe(); recycle({memory,kernel,lastGauss,lastTransform:null,views}); } }
    finally { [memory,kernel,lastTransform,lastGauss,views,base,resident,dirtyEnd] = previous; }
  };
}

export function referenceArena(scales, pairs = []) {
  let cursor = S2_MEMORY.base;
  const take = bytes => { const at = cursor; cursor += Math.ceil(bytes / 16) * 16; return at; };
  const planes = scales.map(({width, height, keep}) => {
    if (!keep) return null;
    return [0,1,2].map(c => take(width * height * (keep === 'p1' ? 4 : keep === 'y-ms' ? (c === 1 ? 12 : 4) : 12)));
  });
  const planesEnd = cursor;
  const places = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? [] : pairs.map(width => { const rowBytes = ssimulacra2Layout(Math.abs(width),1).rowBytes, p = {rowBytes, scratch0:take(rowBytes), sums0:take(144)}; return width < 0 ? p : {...p, scratch1:take(rowBytes), sums1:take(144)}; });
  const arena = {memory:null,kernel:null,lastGauss:null,lastTransform:null,views:null,planes,planesEnd,places,base:cursor,dirtyEnd:cursor};
  const free = largestFree();
  if (free) Object.assign(arena, free);
  return arena;
}

const pooled = [], weak = [];
function largestFree() {
  let at = -1;
  for (let i = 0; i < pooled.length; i++) if (at < 0 || pooled[i].memory.buffer.byteLength > pooled[at].memory.buffer.byteLength) at = i;
  return at >= 0 ? pooled.splice(at, 1)[0] : weak.pop()?.deref();
}
let dropTimer = null;
const dropPool = () => { dropTimer = null; while (pooled.length) weak.push(new WeakRef(pooled.pop())); weak.splice(0, weak.length - 2); };
onCallEnd(() => {}, () => { if (dropTimer) clearTimeout(dropTimer); dropPool(); });
export function dropMetricPool() { if (dropTimer) clearTimeout(dropTimer); dropPool(); }
function recycle(arena) {
  pooled.push(arena);
  if (pooled.length > 2) weak.push(new WeakRef(pooled.shift()));
  if (dropTimer) clearTimeout(dropTimer);
  dropTimer = setTimeout(dropPool, 1000);
  dropTimer.unref?.();
}
function refreshViews() {
  const buffer = memory.buffer;
  if (views?.u8.buffer !== buffer) views = {u8:new Uint8Array(buffer),i32:new Int32Array(buffer),f32:new Float32Array(buffer),f64:new Float64Array(buffer)};
}
function armProbe() { if (fusedOf() && !(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true)) views.f32.set(FUSED_PROBE,PROBE >> 2); }
function clearProbe() {
  refreshViews();
  views.u8.fill(0, 0, TRANSFORM_AT);
  if (lastTransform) views.u8.fill(0, TRANSFORM_AT, LUT);
  views.u8.fill(0, base, dirtyEnd);
}
export const clearReferenceProbe = (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? null : function clearReferenceProbe(arena) {
  if (!arena?.memory) return;
  if (arena.lastTransform) {
    new Uint8Array(arena.memory.buffer).fill(0, TRANSFORM_AT, LUT);
    arena.lastTransform = null;
  }
};
export function releaseReferenceArena(arena) {
  if (!arena?.memory) return;
  const u8 = new Uint8Array(arena.memory.buffer), end = Math.max(arena.base, arena.dirtyEnd ?? 0);
  if (arena.dirtyEnd > arena.base) u8.fill(0, 0, TRANSFORM_AT);
  if (arena.lastTransform) u8.fill(0, TRANSFORM_AT, LUT);
  if (end > S2_MEMORY.base) u8.fill(0, S2_MEMORY.base, end);
  arena.dirtyEnd = arena.base; arena.lastTransform = null;
  recycle({memory:arena.memory,kernel:arena.kernel,lastGauss:arena.lastGauss,lastTransform:null,views:arena.views});
  arena.memory = arena.kernel = arena.lastGauss = arena.views = null;
}
export function useReferenceArena(arena, clear = true) {
  const previous = [memory,kernel,lastTransform,lastGauss,views,base,resident,dirtyEnd];
  [memory,kernel,lastGauss,lastTransform,views] = [arena.memory,arena.kernel,arena.lastGauss,arena.lastTransform ?? null,arena.views];
  base = dirtyEnd = arena.base; resident = arena;
  if (memory) { refreshViews(); armProbe(); }
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    try {
      if (memory) {
        if (dirtyEnd > (arena.dirtyEnd ?? arena.base)) arena.dirtyEnd = dirtyEnd;
        if (clear) {
          refreshViews();
          views.u8.fill(0, 0, TRANSFORM_AT);
          if (lastTransform) { views.u8.fill(0, TRANSFORM_AT, LUT); lastTransform = null; }

        }
      }
      [arena.memory,arena.kernel,arena.lastGauss,arena.lastTransform,arena.views] = [memory,kernel,lastGauss,lastTransform,views];
    } finally {
      [memory,kernel,lastTransform,lastGauss,views,base,resident,dirtyEnd] = previous;
    }
  };
}

function ready() {
  if (kernel) return;
  const module = kernelModule();
  let owned;
  try { owned = new WebAssembly.Memory({initial:Math.ceil(S2_MEMORY.base / 65536), maximum:S2_MEMORY.maximumPages}); }
  catch (cause) { throw Object.assign(fault('JXL_MEMORY','SSIMULACRA2: out of memory'),{cause}); }
  const exports = new WebAssembly.Instance(module,{env:{memory:owned}}).exports;
  exports.s2MetricInit(LUT);
  if (typeof __RAPIER_JXL_UPLOAD__ === 'undefined' || __RAPIER_JXL_UPLOAD__ !== true) {
    const fast = fusedModule();
    if (exports.s2Fused && fast) {
      new Float32Array(owned.buffer,PROBE,16).set(FUSED_PROBE);
      const leaf = new WebAssembly.Instance(fast,{env:{memory:owned}}).exports;
      exports.s2Fused.set(1, leaf.s2FusedBlur4); exports.s2Fused.set(2, leaf.s2FusedVertRow);
      FUSED_OF.set(exports, leaf);
    }
  }
  memory = owned; kernel = exports; refreshViews();
}

function runWithFused(fn, args) {
  const fused = fusedOf();
  if (fused && fusedAllowed && fusedState > 0) {
    const failed = FAILED >> 2, use = USE_FUSED >> 2;
    views.i32[failed] = 0; views.i32[use] = 1;
    let out;
    try { out = fn(...args); } finally { views.i32[use] = 0; }
    if (views.i32[failed]) { fusedState = -2; FUSED_OF.delete(kernel); }
    return out;
  }
  if (views) views.i32[USE_FUSED >> 2] = 0;
  return fn(...args);
}
const wholeScale = (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true)
  ? function (w,h,_m,reference,refKind,distorted,distKind,c0,c1,c2,bits,scratch,_t,_e,sums) {
    if (metricBand(w,h,-4,h,0,h,reference,refKind,distorted,distKind,LUT,GAUSS,scratch,sums,c0,c1,c2,bits) !== h) throw fault('JXL_INTERNAL','ssimulacra2-arithmetic:whole-band');
  }
  : function (w,h,mask,reference,refKind,distorted,distKind,c0,c1,c2,bits,scratch,terms,edgeTerms,sums) {
    runWithFused(kernel.s2MetricScale, [w,h,mask,reference,refKind,distorted,distKind,LUT,GAUSS,c0,c1,c2,bits,scratch,terms,edgeTerms,sums]);
  };
function metricBand(w,h,first,end,inY,inH,ref,refKind,dist,distKind,lin,g,scratch,sums,c0,c1,c2,cmask) {
  return (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true)
    ? kernel.s2MetricScaleMeter(w,h,first,end,inY,inH,ref,refKind,dist,distKind,lin,g,scratch,sums,c0,c1,c2,cmask)
    : runWithFused(kernel.s2MetricBand, [w,h,first,end,inY,inH,ref,refKind,dist,distKind,lin,g,scratch,sums,c0,c1,c2,cmask]);
}
function metricBand2(w,h,first,end,inY,inH,ref,refKind,dist0,dist0Kind,dist1,dist1Kind,lin,g,scratch0,sums0,scratch1,sums1,c0,c1,c2,cmask) {
  return kernel.s2MetricBand2 ? runWithFused(kernel.s2MetricBand2, [w,h,first,end,inY,inH,ref,refKind,dist0,dist0Kind,dist1,dist1Kind,lin,g,scratch0,sums0,scratch1,sums1,c0,c1,c2,cmask]) : null;
}
function reserve(plan) {
  ready();
  if (plan.arenaBytes > memory.buffer.byteLength) {
    try { memory.grow(Math.ceil((plan.arenaBytes - memory.buffer.byteLength) / 65536)); }
    catch (cause) { throw Object.assign(fault('JXL_MEMORY','SSIMULACRA2: out of memory'),{cause}); }
  }
  refreshViews();
  dirtyEnd = Math.max(dirtyEnd,plan.arenaBytes);
}
const inputBytes = (input,n) => input.rgba ? n * 4 : n * 12;
const inputKind = input => input?.transform ? 2 : input?.rgba ? 0 : 1;
function syncTransform(tr = null) {
  if (tr === lastTransform) return;
  if (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) && tr) views.f64.set(transformTable(tr).table, TRANSFORM_AT >> 3);
  lastTransform = tr;
}
function writeInput(input,at,n) {
  if (!at || !input) return;
  if (input.rgba) views.u8.set(input.rgba.subarray(0,n * 4),at);
  else for (let c = 0; c < 3; c++) views.f32.set(input[c].subarray(0,n),(at >> 2) + c * n);
}
function writeInputRows(input,at,w,y0,rows) {
  if (!at || !input) return;
  const off = y0 * w, n = rows * w;
  if (input.rgba) views.u8.set(input.rgba.subarray(off * 4,(off + n) * 4),at);
  else for (let c = 0; c < 3; c++) views.f32.set(input[c].subarray(off,off + n),(at >> 2) + c * n);
}

const TABLE_ARITHMETIC = GAUSS + 252;
function syncArithmetic(libjxl) {
  const want = libjxl ? 1 : 0;
  if (views.i32[TABLE_ARITHMETIC >> 2] === want) return;
  if (libjxl && !kernel.s2LibjxlInit) throw fault('JXL_INTERNAL','ssimulacra2-arithmetic:upload');
  (libjxl ? kernel.s2LibjxlInit : kernel.s2MetricInit)(LUT);
  views.i32[TABLE_ARITHMETIC >> 2] = want;
}
const arithmeticFlag = libjxl => { syncArithmetic(libjxl); views.i32[(GAUSS + 248) >> 2] = libjxl ? 1 : 0; };
function copyGauss(g) {
  if (g === lastGauss) return;
  if (!(typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true))
    views.f32.set([...g.n2,...g.d1,...g.coefficients.flatMap(p => [...p.input,...p.previous,...p.previous2])],GAUSS >> 2);
  views.f32.set(g.taps,(GAUSS + 256) >> 2);
  lastGauss = g;
}

let linearLookup = null;
export function s2LinearTable() {
  if (!linearLookup) {
    const close = openMetricArena();
    try { ready(); refreshViews(); syncArithmetic(false); linearLookup = new Float32Array(memory.buffer,LUT,256).slice(); } finally { close(); }
  }
  return linearLookup.slice();
}

let deviceTables = null;
export const s2DeviceTables = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? null : function s2DeviceTables(g) {
  if (deviceTables) return deviceTables;
  const close = openMetricArena();
  try {
    ready(); refreshViews(); syncArithmetic(false);
    const words = new Uint32Array(512);
    words.set(new Uint32Array(memory.buffer,LUT,256));
    words.set(new Uint32Array(g.taps.buffer, g.taps.byteOffset, 5),256);
    return deviceTables = words;
  } finally { close(); }
};

export function downsample(input,width,height,into = null,libjxl = false) {
  const w = Math.ceil(width / 2), h = Math.ceil(height / 2), n = width * height, m = w * h;
  const plan = s2ArenaPlan({base}), source = plan.take(inputBytes(input,n)), output = plan.take(m * 12);
  reserve(plan); syncArithmetic(libjxl); syncTransform((typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? null : (input.transform ?? null)); writeInput(input,source,n);
  kernel.s2MetricDown(width,height,source,inputKind(input),LUT,output);
  const planes = into ? into.map(p => p.subarray(0,m)) : [0,1,2].map(() => new Float32Array(m));
  for (let c = 0; c < 3; c++) planes[c].set(new Float32Array(memory.buffer,output + c * m * 4,m));
  return {planes,width:w,height:h};
}

const bandCacheMask = mode => mode === true ? 7 : mode === 'y-ms' ? 42 : mode === 'p1' ? 56 : mode === 'fill-p1' ? 64 : mode === 'fill-y-ms' ? 704 : 0;
export const scaleBand = (typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) ? null
  : (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? function scaleBand(a,b,w,h,g,first,end,place,sparse) {
    const inputY = Math.min(h,Math.ceil((first + 4) / 4) * 4), inputEnd = Math.min(h,Math.ceil((end + 4) / 4) * 4), inputH = inputEnd - inputY;
    const plan = ssimulacra2Layout(w,Math.max(1,inputH),{place:true,referenceRgba:!!a.rgba,distortedRgba:!!b.rgba,base});
    reserve(plan); copyGauss(g); syncTransform(null);
    writeInput(a,plan.reference,w * inputH); writeInput(b,plan.distorted,w * inputH);
    if (metricBand(w,h,first,end,inputY,inputH,plan.reference,a.rgba ? 0 : 1,plan.distorted,b.rgba ? 0 : 1,LUT,GAUSS,place.scratch0,place.sums0,0,0,0,sparse ? 16384 : 0) !== inputEnd)
      throw fault('JXL_INTERNAL','ssimulacra2-arithmetic:rows-1');
    return new Float64Array(memory.buffer,place.sums0,18).slice();
  }
  : function scaleBand(a,b,w,h,g,first,end,previous = null,from = null,libjxl = false,place = null,planes = null,cached = false,boundMask = 0) {
  const inputY = from ?? Math.min(h,Math.ceil((first + 4) / 4) * 4);
  const inputEnd = Math.min(h,Math.ceil((end + 4) / 4) * 4), inputH = inputEnd - inputY, heldRef = cached === true || cached === 'y-ms' || cached === 'p1';
  const plan = ssimulacra2Layout(w,Math.max(1,inputH),{cached:cached === true ? 7 : cached === 'y-ms' ? 2 : 0,cachedP1:cached === 'p1' || cached === 'y-ms' ? 7 : 0,resident:!!planes,place:!!place,referenceRgba:!heldRef && !!a?.rgba,distortedRgba:!!b.rgba,base});
  if (place) { plan.scratch = place.scratch0; plan.sums = place.sums0; }
  const tr = (!heldRef && a?.transform) || b.transform || null;
  reserve(plan); copyGauss(g); syncTransform(tr);
  writeInput(a,plan.reference,w * inputH); writeInput(b,plan.distorted,w * inputH);
  if (previous && !previous.resident) {
    if (previous.states) {
      const scratch = new Float32Array(memory.buffer,plan.scratch,plan.rowBytes >> 2);
      for (let i = 0; i < 15; i++) scratch.set(previous.states.subarray(i * 6 * w,(i + 1) * 6 * w),stateAt(i,w));
    } else new Uint8Array(memory.buffer,plan.scratch,plan.rowBytes).set(previous.scratch);
    new Float64Array(memory.buffer,plan.sums,18).set(previous.sums);
  }
  arithmeticFlag(libjxl);
  const [c0,c1,c2] = planes ?? [0,0,0];
  const made = metricBand(w,h,first,end,inputY,inputH,plan.reference,inputKind(a),
    plan.distorted,inputKind(b),LUT,GAUSS,plan.scratch,plan.sums,c0,c1,c2,bandCacheMask(cached) | (boundMask & 1 ? 10240 : 0) | (boundMask & 2 ? 16384 : 0));
  if (made !== inputEnd) throw fault('JXL_INTERNAL','ssimulacra2-arithmetic:rows-1');
  const sums = new Float64Array(memory.buffer,plan.sums,18).slice();
  return place ? {resident:true,output:0,sums} : {scratch:new Uint8Array(memory.buffer,plan.scratch,plan.rowBytes).slice(),sums};
};

export const scaleBandPair = ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) || (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true)) ? null : function scaleBandPair(a,b0,b1,w,h,g,first,end,previous0 = null,previous1 = null,from = null,place = null,libjxl = false,planes = null,cached = false,boundMask = 0) {
  ready();
  if (!kernel.s2MetricBand2) return null;
  const inputY = from ?? Math.min(h,Math.ceil((first + 4) / 4) * 4);
  const inputEnd = Math.min(h,Math.ceil((end + 4) / 4) * 4), inputH = inputEnd - inputY, heldRef = cached === true || cached === 'y-ms' || cached === 'p1';
  const plan = ssimulacra2Layout(w,Math.max(1,inputH),{cached:cached === true ? 7 : cached === 'y-ms' ? 2 : 0,cachedP1:cached === 'p1' || cached === 'y-ms' ? 7 : 0,resident:!!planes,place:!!place,referenceRgba:!heldRef && !!a?.rgba,distortedRgba:!!b0.rgba,base});
  if (place && place.rowBytes < plan.rowBytes || !place && (previous0?.resident || previous1?.resident))
    throw fault('JXL_INTERNAL','ssimulacra2-arithmetic:scale');
  const more = s2ArenaPlan({base:plan.arenaBytes}), distorted1 = more.take(inputBytes(b1,w * inputH)), scratch1 = place ? place.scratch1 : more.take(plan.rowBytes), sums1 = place ? place.sums1 : more.take(18 * 8);
  if (place) { plan.scratch = place.scratch0; plan.sums = place.sums0; }
  const tr = (!heldRef && a?.transform) || b0.transform || b1.transform || null;
  reserve({arenaBytes:more.arenaBytes}); copyGauss(g); syncTransform(tr);
  writeInput(a,plan.reference,w * inputH); writeInput(b0,plan.distorted,w * inputH); writeInput(b1,distorted1,w * inputH);
  for (const [previous,scratch,sums] of [[previous0,plan.scratch,plan.sums],[previous1,scratch1,sums1]]) if (previous && !previous.resident) {
    if (previous.states) {
      const rows = new Float32Array(memory.buffer,scratch,plan.rowBytes >> 2);
      for (let i = 0; i < 15; i++) rows.set(previous.states.subarray(i * 6 * w,(i + 1) * 6 * w),stateAt(i,w));
    } else new Uint8Array(memory.buffer,scratch,plan.rowBytes).set(previous.scratch);
    new Float64Array(memory.buffer,sums,18).set(previous.sums);
  }
  arithmeticFlag(libjxl);
  const [c0,c1,c2] = planes ?? [0,0,0];
  const made = metricBand2(w,h,first,end,inputY,inputH,plan.reference,inputKind(a),plan.distorted,inputKind(b0),
    distorted1,inputKind(b1),LUT,GAUSS,plan.scratch,plan.sums,scratch1,sums1,c0,c1,c2,bandCacheMask(cached) | (boundMask & 1 ? 10240 : 0) | (boundMask & 2 ? 16384 : 0));
  if (made === null) return null;
  if (made !== inputEnd) throw fault('JXL_INTERNAL','ssimulacra2-arithmetic:rows-2');
  if (place) return [plan.sums,sums1].map((sums,k) => ({resident:true,output:k,sums:new Float64Array(memory.buffer,sums,18).slice(),pair:true}));
  return [[plan.scratch,plan.sums],[scratch1,sums1]].map(([scratch,sums]) => ({scratch:new Uint8Array(memory.buffer,scratch,plan.rowBytes).slice(),
    sums:new Float64Array(memory.buffer,sums,18).slice(),pair:true}));
};

export const residentScratch = ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) || (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true)) ? null : function residentScratch(arena,place,k) {
  return new Uint8Array(arena.memory.buffer,k ? place.scratch1 : place.scratch0,place.rowBytes).slice();
};

export const pairState = ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) || (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true)) ? null : function pairState(first,second,w) {
  const states = second.states.slice();
  for (let c = 0; c < 3; c++) for (const k of [0,2]) states.set(first.states.subarray((c * 5 + k) * 6 * w,(c * 5 + k + 1) * 6 * w),(c * 5 + k) * 6 * w);
  return {states,sums:second.sums};
};

const BAND_RING = 16, stateAt = (i,w) => (6 * BAND_RING + 8 + i * (BAND_RING + 7) + BAND_RING) * w;
export const bandState = ((typeof __RAPIER_JXL_CAPTURE_PHOTO__ !== 'undefined' && __RAPIER_JXL_CAPTURE_PHOTO__ === true) || (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true)) ? null : function bandState({scratch,sums},w) {
  const all = new Float32Array(scratch.buffer,scratch.byteOffset,scratch.byteLength >> 2), states = new Float32Array(15 * 6 * w);
  for (let i = 0; i < 15; i++) states.set(all.subarray(stateAt(i,w),stateAt(i,w) + 6 * w),i * 6 * w);
  return {states,sums};
};

function residentMaskFor(keep, heldBits, mask) {
  if (!keep) return {cachedMs: 0, cachedP1: 0, cMask: 0};
  if (keep === 'p1') {
    const p1 = heldBits & mask, fill = (mask & ~heldBits);
    return {cachedMs: 0, cachedP1: p1, cMask: (p1 << 3) | (fill ? 64 | (fill === 7 ? 0 : fill << 7) : 0)};
  }
  if (keep === 'y-ms') {
    const ms = heldBits & 2 & mask, p1 = heldBits & 5 & mask, fillP1 = (mask & ~heldBits) & 5;
    return {cachedMs: ms, cachedP1: ms | p1, cMask: ms | (p1 << 3) | (fillP1 ? 64 | (fillP1 << 7) : 0)};
  }
  const ms = heldBits & mask;
  return {cachedMs: ms, cachedP1: ms, cMask: ms};
}

export const scaleComplete = ch => ch?.length === 3 && !ch.some(c => !c || c.partial);
const channelCacheBytes = (keep, c, n) => keep === 'p1' ? n * 4 : keep === 'y-ms' ? (c === 1 ? n * 12 : n * 4) : n * 12;

function recordResidentCache(fixed, channels, keep, fullMask, n, boundD = false) {
  if (!fixed || !keep || !channels) return;
  for (let c = 0; c < 3; c++) {
    if ((fullMask & (1 << c)) && !channels[c]) {
      const partial = boundD && c !== 1 && keep === true;
      const entry = {resident: true, bytes: channelCacheBytes(partial ? 'p1' : keep, c, n), partial};
      channels[c] = entry;
      fixed.cacheBytes += entry.bytes;
    }
  }
}

export function scoreBands(a, b0, b1, width, height, g, fixed, libjxl = false, sparse0 = false, startScale = 0) {
  ready();
  if (b1 && !kernel.s2MetricBand2) {
    const out0 = scoreBands(a, b0, null, width, height, g, fixed, libjxl, sparse0, startScale);
    let needRef2 = !fixed;
    if (fixed) for (let s = startScale; s < fixed.scales.length; s++) if (!scaleComplete(fixed.scales[s])) { needRef2 = true; break; }
    const out1 = scoreBands(needRef2 ? a : null, b1, null, width, height, g, fixed, libjxl, sparse0, startScale);
    return [out0, out1];
  }
  const dims = [];
  for (let s = 0, sw = width, sh = height; s < 6; s++) {
    if (sw < 8 || sh < 8) break;
    if (s) { sw = (sw + 1) >> 1; sh = (sh + 1) >> 1; }
    const ch = fixed?.scales[s] ?? null, keep = fixed ? fixed.sizes[s].keep : false;
    let heldBits = 0;
    for (let c = 0; c < 3; c++) if (ch?.[c]) heldBits |= 1 << c;
    const res = resident?.planes[s] ?? null;
    const {cachedMs, cachedP1, cMask} = res ? residentMaskFor(keep, heldBits, 7) : {cachedMs: 0, cachedP1: 0, cMask: 0};
    const activeScale = s >= startScale;
    const needRef = activeScale && ((7 & ~cachedP1) !== 0);
    const useSparse = s === 0 && sparse0 && (scaleComplete(ch) || keep !== true);
    let active = 0;
    for (let c = 0; c < 3; c++) active += (cachedMs & (1 << c)) ? 3 : 5;
    const rowBytes = activeScale ? ((needRef ? 48 : 0) + 80 + 24 * active) * sw * 4 : 0;
    dims.push({s, w: sw, h: sh, n: sw * sh, ch, keep, res, cMask: cMask | (useSparse ? 16384 : 0), needRef, rowBytes,
      at: res ? [0, 1, 2].map(c => (keep || (heldBits & (1 << c))) ? res[c] : 0) : [0, 0, 0],
      scratch0: 0, sums0: 0, scratch1: 0, sums1: 0});
  }
  let lastRefScale = -1;
  for (let s = startScale; s < dims.length; s++) if (dims[s].needRef) lastRefScale = s;
  const needAnyRef = lastRefScale >= 0;
  const maxBand0 = Math.min(height, BAND_ROWS), maxN0 = width * maxBand0;
  const plan = s2ArenaPlan({base});
  for (let s = startScale; s < dims.length; s++) {
    const d = dims[s];
    d.scratch0 = plan.take(d.rowBytes); d.sums0 = plan.take(144);
    if (b1) { d.scratch1 = plan.take(d.rowBytes); d.sums1 = plan.take(144); }
  }
  const refIn0 = needAnyRef ? plan.take(inputBytes(a, maxN0)) : 0;
  const dist0In0 = plan.take(inputBytes(b0, maxN0));
  const dist1In0 = b1 ? plan.take(inputBytes(b1, maxN0)) : 0;
  const maxH1 = dims.length > 1 ? Math.ceil(maxBand0 / 2) : 0, maxN1 = dims.length > 1 ? dims[1].w * maxH1 : 0;
  const maxH2 = dims.length > 2 ? Math.ceil(maxH1 / 2) : 0, maxN2 = dims.length > 2 ? dims[2].w * maxH2 : 0;
  const refPing = lastRefScale >= 1 ? [plan.take(maxN1 * 12), maxN2 ? plan.take(maxN2 * 12) : 0] : null;
  const dist0Ping = dims.length > 1 ? [plan.take(maxN1 * 12), maxN2 ? plan.take(maxN2 * 12) : 0] : null;
  const dist1Ping = b1 && dims.length > 1 ? [plan.take(maxN1 * 12), maxN2 ? plan.take(maxN2 * 12) : 0] : null;
  reserve(plan); copyGauss(g);
  syncTransform((needAnyRef && a?.transform) || b0.transform || b1?.transform || null);
  arithmeticFlag(libjxl);
  const aKind0 = inputKind(a), b0Kind0 = inputKind(b0), b1Kind0 = b1 ? inputKind(b1) : 0;

  for (let y0 = 0; y0 < height; y0 += BAND_ROWS) {
    const y1 = Math.min(height, y0 + BAND_ROWS), last = y1 === height, h0 = y1 - y0;
    if (needAnyRef) writeInputRows(a, refIn0, width, y0, h0);
    writeInputRows(b0, dist0In0, width, y0, h0);
    if (b1) writeInputRows(b1, dist1In0, width, y0, h0);

    let curRef = refIn0, curRefKind = aKind0, curB0 = dist0In0, curB0Kind = b0Kind0, curB1 = dist1In0, curB1Kind = b1Kind0, prevW = width, prevH = h0;
    for (let s = 0; s < dims.length; s++) {
      const d = dims[s], inY = y0 >> s, inEnd = last ? d.h : (y1 >> s), inH = inEnd - inY;
      if (s > 0) {
        const slot = (s - 1) & 1;
        if (s <= lastRefScale) {
          const nextRef = refPing[slot];
          kernel.s2MetricDown(prevW, prevH, curRef, curRefKind, LUT, nextRef);
          curRef = nextRef; curRefKind = 1;
        }
        const nextB0 = dist0Ping[slot];
        kernel.s2MetricDown(prevW, prevH, curB0, curB0Kind, LUT, nextB0);
        curB0 = nextB0; curB0Kind = 1;
        if (b1) {
          const nextB1 = dist1Ping[slot];
          kernel.s2MetricDown(prevW, prevH, curB1, curB1Kind, LUT, nextB1);
          curB1 = nextB1; curB1Kind = 1;
        }
        prevW = d.w; prevH = inH;
      }
      if (s < startScale) continue;
      const first = y0 === 0 ? -4 : inY - 4, end = last ? d.h : inEnd - 4, refPtr = d.needRef ? curRef : 0;
      const made = b1
        ? metricBand2(d.w, d.h, first, end, inY, inH, refPtr, curRefKind, curB0, curB0Kind, curB1, curB1Kind,
            LUT, GAUSS, d.scratch0, d.sums0, d.scratch1, d.sums1, d.at[0], d.at[1], d.at[2], d.cMask)
        : metricBand(d.w, d.h, first, end, inY, inH, refPtr, curRefKind, curB0, curB0Kind,
            LUT, GAUSS, d.scratch0, d.sums0, d.at[0], d.at[1], d.at[2], d.cMask);
      if (made !== inEnd) throw fault('JXL_INTERNAL', 'ssimulacra2-arithmetic:band-cascade');
    }
  }
  const out0 = [], out1 = b1 ? [] : null;
  for (let s = startScale; s < dims.length; s++) {
    const d = dims[s];
    if (d.res) recordResidentCache(fixed, d.ch, d.keep, 7, d.n, false);
    out0.push({w: d.w, h: d.h, n: d.n, sums: views.f64.slice(d.sums0 >> 3, (d.sums0 >> 3) + 18)});
    if (b1) out1.push({w: d.w, h: d.h, n: d.n, sums: views.f64.slice(d.sums1 >> 3, (d.sums1 >> 3) + 18)});
  }
  return b1 ? [out0, out1] : out0;
}

export function scoreScale0Bands(a, b0, b1, w, h, g, fixed, libjxl = false, sparse0 = false, boundD = false, channelMask = 7) {
  ready();
  if (b1 && !kernel.s2MetricBand2) {
    const r0 = scoreScale0Bands(a, b0, null, w, h, g, fixed, libjxl, sparse0, boundD, channelMask);
    const ch0 = fixed?.scales[0];
    const r1 = scoreScale0Bands(scaleComplete(ch0) ? null : a, b1, null, w, h, g, fixed, libjxl, sparse0, boundD, channelMask);
    return [r0, r1];
  }
  const ch = fixed?.scales[0] ?? null, keep = fixed ? fixed.sizes[0].keep : false, n = w * h;
  const mask = boundD ? 2 : channelMask, fullMask = boundD ? 7 : mask;
  const sparseBit = sparse0 ? 16384 : 0, boundBit = boundD ? 10240 : (mask !== 7 ? (mask << 10) : 0);
  let heldBits = 0;
  for (let c = 0; c < 3; c++) if (ch?.[c]) heldBits |= 1 << c;
  const res = resident?.planes[0] ?? null;
  const {cachedMs, cachedP1, cMask} = res ? residentMaskFor(keep, heldBits, fullMask) : {cachedMs: 0, cachedP1: 0, cMask: 0};
  const needRef = (fullMask & ~cachedP1) !== 0;
  let active = 0;
  for (let c = 0; c < 3; c++) if (fullMask & (1 << c)) active += (cachedMs & (1 << c)) ? 3 : 5;
  const rowBytes = ((needRef ? 48 : 0) + 80 + 24 * active) * w * 4;
  const maxBand = Math.min(h, BAND_ROWS), maxN = w * maxBand;
  const plan = s2ArenaPlan({base});
  const scratch0 = plan.take(rowBytes), sums0 = plan.take(144);
  const scratch1 = b1 ? plan.take(rowBytes) : 0, sums1 = b1 ? plan.take(144) : 0;
  const refIn = needRef ? plan.take(inputBytes(a, maxN)) : 0;
  const dist0In = plan.take(inputBytes(b0, maxN));
  const dist1In = b1 ? plan.take(inputBytes(b1, maxN)) : 0;
  reserve(plan); copyGauss(g);
  syncTransform((needRef && a?.transform) || b0.transform || b1?.transform || null);
  arithmeticFlag(libjxl);
  const at = res ? [0, 1, 2].map(c => (fullMask & (1 << c)) && (keep || (heldBits & (1 << c))) ? res[c] : 0) : [0, 0, 0];
  const finalMask = cMask | sparseBit | boundBit;
  const aKind = inputKind(a), b0Kind = inputKind(b0), b1Kind = b1 ? inputKind(b1) : 0;

  for (let y0 = 0; y0 < h; y0 += BAND_ROWS) {
    const y1 = Math.min(h, y0 + BAND_ROWS), last = y1 === h, inH = y1 - y0;
    if (needRef) writeInputRows(a, refIn, w, y0, inH);
    writeInputRows(b0, dist0In, w, y0, inH);
    if (b1) writeInputRows(b1, dist1In, w, y0, inH);
    const first = y0 === 0 ? -4 : y0 - 4, end = last ? h : y1 - 4;
    const made = b1
      ? metricBand2(w, h, first, end, y0, inH, refIn, aKind, dist0In, b0Kind, dist1In, b1Kind,
          LUT, GAUSS, scratch0, sums0, scratch1, sums1, at[0], at[1], at[2], finalMask)
      : metricBand(w, h, first, end, y0, inH, refIn, aKind, dist0In, b0Kind,
          LUT, GAUSS, scratch0, sums0, at[0], at[1], at[2], finalMask);
    if (made !== y1) throw fault('JXL_INTERNAL', 'ssimulacra2-arithmetic:scale0-band');
  }
  if (res) recordResidentCache(fixed, ch, keep, fullMask, n, boundD);
  const s0 = views.f64.slice(sums0 >> 3, (sums0 >> 3) + 18);
  return b1 ? [s0, views.f64.slice(sums1 >> 3, (sums1 >> 3) + 18)] : s0;
}

export function scaleSums(a,b,w,h,g,channels,keep,_colors,channel = null,terms = null,scale = 0,libjxl = false,sparse0 = false,boundD = false) {
  const mask = boundD ? 2 : channel === null ? 7 : 1 << channel;
  const sparseBit = sparse0 && !terms ? 16384 : 0, boundBit = boundD && !terms ? 8192 : 0;
  let heldBits = 0;
  for (let c = 0; c < 3; c++) if (channels?.[c]) heldBits |= 1 << c;
  const planes = resident?.planes[scale] ?? null;
  if (planes) return residentSums(a,b,w,h,g,channels,keep,mask,heldBits,terms,planes,libjxl,sparseBit | boundBit,boundD);
  const plan = ssimulacra2Layout(w,h,{channels:boundD ? 7 : mask,cached:heldBits,retain:keep ? (boundD ? 7 : mask) : 0,map:!!terms,
    referenceRgba:!!a?.rgba,distortedRgba:!!b.rgba,base});
  const n = plan.pixels;
  reserve(plan); copyGauss(g); syncTransform(null);
  writeInput(a,plan.reference,n); writeInput(b,plan.distorted,n);
  for (let c = 0; c < 3; c++) if (plan.caches[c] && channels?.[c])
    for (const [k,key] of ['p1','mu1','s11'].entries())
      if (channels[c][key]) new Float32Array(memory.buffer,plan.caches[c] + k * n * 4,n).set(channels[c][key]);
  arithmeticFlag(libjxl);
  wholeScale(w,h,mask,plan.reference,a?.rgba ? 0 : 1,plan.distorted,b.rgba ? 0 : 1,
    ...plan.caches,plan.cachedMask | sparseBit | boundBit,plan.scratch,plan.terms,plan.edgeTerms,plan.sums);
  if (terms) {
    terms.d.set(new Float64Array(memory.buffer,plan.terms,n));
    terms.dd.set(new Float64Array(memory.buffer,plan.edgeTerms,n));
  }
  return [0,1,2].map(c => ({sums:views.f64.slice((plan.sums >> 3) + c * 6,(plan.sums >> 3) + (c + 1) * 6),
    reference:keep && (mask & (1 << c)) && !channels?.[c]
      ? Object.fromEntries(['p1','mu1','s11'].map((key,k) => [key,new Float32Array(memory.buffer,plan.caches[c] + k * n * 4,n).slice()]))
      : null}));
}

function residentSums(a,b,w,h,g,channels,keep,mask,heldBits,terms,planes,libjxl,extraMask = 0,boundD = false) {
  const fullMask = boundD ? 7 : mask;
  const {cachedMs, cachedP1, cMask} = residentMaskFor(keep, heldBits, fullMask);
  const plan = ssimulacra2Layout(w,h,{channels:fullMask,cached:cachedMs,cachedP1,map:!!terms,referenceRgba:!!a?.rgba,distortedRgba:!!b.rgba,
    base,resident:true});
  const n = plan.pixels;
  reserve(plan); copyGauss(g); syncTransform(null);
  writeInput(a,plan.reference,n); writeInput(b,plan.distorted,n);
  const at = [0,1,2].map(c => fullMask & (1 << c) && (keep || heldBits & (1 << c)) ? planes[c] : 0);
  arithmeticFlag(libjxl);
  wholeScale(w,h,mask,plan.reference,a?.rgba ? 0 : 1,plan.distorted,b.rgba ? 0 : 1,
    ...at,cMask | extraMask,plan.scratch,plan.terms,plan.edgeTerms,plan.sums);
  if (terms) {
    terms.d.set(new Float64Array(memory.buffer,plan.terms,n));
    terms.dd.set(new Float64Array(memory.buffer,plan.edgeTerms,n));
  }
  return [0,1,2].map(c => ({sums:views.f64.slice((plan.sums >> 3) + c * 6,(plan.sums >> 3) + (c + 1) * 6),
    reference:keep && (fullMask & (1 << c)) && !channels?.[c]
      ? {resident:true,bytes:channelCacheBytes(boundD && c !== 1 && keep === true ? 'p1' : keep, c, n), partial: boundD && c !== 1 && keep === true}
      : null}));
}

export function scaleSumsPair(a,b0,b1,w,h,g,channels,keep,colors,scale = 0,libjxl = false,sparse0 = false,boundD = false,channelMask = 7) {
  ready();
  if (!kernel.s2MetricBand2) {
    const r0 = scaleSums(a,b0,w,h,g,channels,keep,colors,null,null,scale,libjxl,sparse0,boundD);
    const nextChannels = channels ? channels.map((ch, c) => ch ?? r0[c].reference) : null;
    const r1 = scaleSums(scaleComplete(nextChannels) ? null : a,b1,w,h,g,nextChannels,false,colors,null,null,scale,libjxl,sparse0,boundD);
    return [r0, r1];
  }
  const mask = boundD ? 2 : channelMask, fullMask = boundD ? 7 : mask;
  const sparseBit = sparse0 ? 16384 : 0, boundBit = boundD ? 10240 : (mask !== 7 ? (mask << 10) : 0);
  let heldBits = 0;
  for (let c = 0; c < 3; c++) if (channels?.[c]) heldBits |= 1 << c;
  const planes = resident?.planes[scale] ?? null;
  const {cachedMs, cachedP1, cMask} = planes ? residentMaskFor(keep, heldBits, fullMask) : {cachedMs: 0, cachedP1: 0, cMask: 0};
  const plan = ssimulacra2Layout(w,h,{channels:fullMask,cached:planes ? cachedMs : heldBits,cachedP1:planes ? cachedP1 : heldBits,
    retain:!planes && keep ? fullMask : 0,referenceRgba:!!a?.rgba,distortedRgba:!!b0.rgba,base,resident:!!planes});
  const n = plan.pixels;
  const more = s2ArenaPlan({base:plan.arenaBytes}), distorted1 = more.take(inputBytes(b1,n)), scratch1 = more.take(plan.rowBytes), sums1 = more.take(18 * 8);
  reserve({arenaBytes:more.arenaBytes}); copyGauss(g); syncTransform(null);
  writeInput(a,plan.reference,n); writeInput(b0,plan.distorted,n); writeInput(b1,distorted1,n);
  if (!planes) {
    for (let c = 0; c < 3; c++) if (plan.caches[c] && channels?.[c])
      for (const [k,key] of ['p1','mu1','s11'].entries())
        if (channels[c][key]) new Float32Array(memory.buffer,plan.caches[c] + k * n * 4,n).set(channels[c][key]);
  }
  const at = planes ? [0,1,2].map(c => keep || heldBits & (1 << c) ? planes[c] : 0) : plan.caches;
  const finalMask = (planes ? cMask : plan.cachedMask) | sparseBit | boundBit;
  arithmeticFlag(libjxl);
  const made = metricBand2(w,h,-4,h,0,h,plan.reference,a?.rgba ? 0 : 1,plan.distorted,b0.rgba ? 0 : 1,
    distorted1,b1.rgba ? 0 : 1,LUT,GAUSS,plan.scratch,plan.sums,scratch1,sums1,at[0],at[1],at[2],finalMask);
  if (made !== h) throw fault('JXL_INTERNAL','ssimulacra2-arithmetic:pair');
  const out0 = [0,1,2].map(c => ({
    sums:views.f64.slice((plan.sums >> 3) + c * 6,(plan.sums >> 3) + (c + 1) * 6),
    reference:keep && !channels?.[c]
      && (fullMask & (1 << c)) ? (planes
        ? {resident:true,bytes:channelCacheBytes(boundD && c !== 1 && keep === true ? 'p1' : keep, c, n), partial: boundD && c !== 1 && keep === true}
        : (mask & (1 << c)) ? Object.fromEntries(['p1','mu1','s11'].map((key,k) => [key,new Float32Array(memory.buffer,plan.caches[c] + k * n * 4,n).slice()])) : null)
      : null,
  }));
  const out1 = [0,1,2].map(c => ({sums:views.f64.slice((sums1 >> 3) + c * 6,(sums1 >> 3) + (c + 1) * 6),reference:null}));
  return [out0, out1];
}

export function gaussianCoefficients(gauss) {
  if (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) return {taps: Float32Array.from(gauss.taps)};
  const f32 = Math.fround;
  return {radius: gauss.radius, taps: Float32Array.from(gauss.taps), n2: gauss.n2.map(f32), d1: gauss.d1.map(f32),
    coefficients: gauss.d1.map((d, i) => {
      const n = gauss.n2[i], d2 = d * d;
      return {input: [n, -d * n, d2 * n - n, -d2 * d * n + 2 * d * n].map(f32),
        previous: [-d, d2 - 1, -d2 * d + 2 * d, d2 * d2 - 3 * d2 + 1].map(f32),
        previous2: [-1, d, -d2 + 1, d2 * d - 2 * d].map(f32)};
    })};
}