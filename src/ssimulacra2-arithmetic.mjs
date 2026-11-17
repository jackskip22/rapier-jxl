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
import {S2_MEMORY, s2ArenaPlan, ssimulacra2Layout} from './ssimulacra2-memory.mjs';
import {S2_FUSED} from './ssimulacra2-fused-bytes.mjs';
import {wasmBytes} from './wasm-text.mjs';
import {compileWasm, suppliedWasm, wasmModule} from './wasm-modules.mjs';
export {ssimulacra2WorkBytes} from './ssimulacra2-memory.mjs';
const {linear:LUT, gaussian:GAUSS, colorKeys:KEYS, colorValues:VALUES} = S2_MEMORY;
let memory, kernel, fused, lastColors, lastGauss, views;

const PROBE = GAUSS + 176, FAILED = GAUSS + 240, u = 1 + 2 ** -12;
const PROBE_INPUT = [u, -u, 2 * u, u, u, u, u, -2 * u, -(1 + 2 ** -11), 1 + 2 ** -11, -(2 + 2 ** -10), 2 + 2 ** -10];
export const FUSED_PROBE = Float32Array.from([...PROBE_INPUT, ...[0, 1, 2, 3].map(i => PROBE_INPUT[i] * PROBE_INPUT[4 + i] + PROBE_INPUT[8 + i])]);
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
export function bandsAtSpeed() {
  const module = fusedAllowed ? fusedModule() : null;
  if (!module) return true;
  return bandsFused ??= WebAssembly.Module.exports(module).some(entry => entry.name === 's2MetricBand');
}
export async function compileFusedMetric() {
  if (!fusedBytes || fusedState || suppliedWasm()) return;
  try { if (WebAssembly.validate(fusedBytes())) await compileWasm('s2-fused', fusedBytes); } catch {}
}
export function fusedMetric(allow = fusedAllowed) {
  fusedAllowed = allow;
  return allow && !!fusedModule();
}

let base = S2_MEMORY.base, resident = null, dirtyEnd = base, colorsUsed = false;
export function openMetricArena() {
  const previous = [memory,kernel,fused,lastColors,lastGauss,views,base,resident,dirtyEnd,colorsUsed];
  const free = pooled.pop() ?? weak.pop()?.deref();
  [memory,kernel,fused,lastGauss,views] = free ? [free.memory,free.kernel,free.fused,free.lastGauss,free.views] : [];
  lastColors = resident = null; base = dirtyEnd = S2_MEMORY.base; colorsUsed = false;
  if (memory) { refreshViews(); if (fused) views.f32.set(FUSED_PROBE,PROBE >> 2); }
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    try { if (memory) { clearProbe(); recycle({memory,kernel,fused,lastGauss,views}); } }
    finally { [memory,kernel,fused,lastColors,lastGauss,views,base,resident,dirtyEnd,colorsUsed] = previous; }
  };
}

export function referenceArena(scales, pairs = []) {
  let cursor = S2_MEMORY.base;
  const take = bytes => { const at = cursor; cursor += Math.ceil(bytes / 16) * 16; return at; };
  const planes = scales.map(({width, height, keep}) => {
    if (!keep) return null;
    return [0,1,2].map(() => take(width * height * 12));
  });
  const places = pairs.map(width => { const rowBytes = ssimulacra2Layout(Math.abs(width),1).rowBytes, p = {rowBytes, scratch0:take(rowBytes), sums0:take(144)}; return width < 0 ? p : {...p, scratch1:take(rowBytes), sums1:take(144)}; });
  const arena = {memory:null,kernel:null,fused:null,lastGauss:null,views:null,planes,places,base:cursor,dirtyEnd:cursor,colorsUsed:false};
  const free = pooled.pop() ?? weak.pop()?.deref();
  if (free) Object.assign(arena, free);
  return arena;
}
const pooled = [], weak = [];
let dropTimer = null;
const dropPool = () => { dropTimer = null; while (pooled.length) weak.push(new WeakRef(pooled.pop())); weak.splice(0, weak.length - 2); };
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
function clearProbe() {
  refreshViews();
  views.u8.fill(0,0,65536);
  if (colorsUsed) {
    views.i32.fill(-1,KEYS >> 2,(KEYS >> 2) + (1 << 17));
    views.u8.fill(0,VALUES,S2_MEMORY.base);
  }
  views.u8.fill(0,base,dirtyEnd);
}
export function releaseReferenceArena(arena) {
  if (!arena?.memory) return;
  const u8 = new Uint8Array(arena.memory.buffer), end = Math.max(arena.base, arena.dirtyEnd ?? 0);
  if (arena.dirtyEnd > arena.base || arena.colorsUsed) u8.fill(0, 0, 65536);
  if (arena.colorsUsed) {
    new Int32Array(arena.memory.buffer, KEYS, 1 << 17).fill(-1);
    u8.fill(0, VALUES, S2_MEMORY.base);
  }
  if (end > S2_MEMORY.base) u8.fill(0, S2_MEMORY.base, end);
  arena.dirtyEnd = arena.base; arena.colorsUsed = false;
  recycle({memory:arena.memory,kernel:arena.kernel,fused:arena.fused,lastGauss:arena.lastGauss,views:arena.views});
  arena.memory = arena.kernel = arena.fused = arena.lastGauss = arena.views = null;
}
export function useReferenceArena(arena, clear = true) {
  const previous = [memory,kernel,fused,lastColors,lastGauss,views,base,resident,dirtyEnd,colorsUsed];
  [memory,kernel,fused,lastGauss,views] = [arena.memory,arena.kernel,arena.fused,arena.lastGauss,arena.views];
  lastColors = null; base = dirtyEnd = arena.base; resident = arena; colorsUsed = false;
  if (memory) { refreshViews(); if (fused) views.f32.set(FUSED_PROBE,PROBE >> 2); }
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    try {
      if (memory) {
        if (clear) clearProbe();
        else {
          if (dirtyEnd > (arena.dirtyEnd ?? arena.base)) arena.dirtyEnd = dirtyEnd;
          if (colorsUsed) arena.colorsUsed = true;
        }
      }
      [arena.memory,arena.kernel,arena.fused,arena.lastGauss,arena.views] = [memory,kernel,fused,lastGauss,views];
    } finally {
      [memory,kernel,fused,lastColors,lastGauss,views,base,resident,dirtyEnd,colorsUsed] = previous;
    }
  };
}

function ready() {
  if (kernel) return;
  const module = kernelModule();
  let owned;
  try { owned = new WebAssembly.Memory({initial:Math.ceil(S2_MEMORY.base / 65536), maximum:S2_MEMORY.maximumPages}); }
  catch (cause) { throw Object.assign(fault('JXL_MEMORY','SSIMULACRA2 memory'),{cause}); }
  const exports = new WebAssembly.Instance(module,{env:{memory:owned}}).exports;
  exports.s2MetricInit(LUT);
  new Int32Array(owned.buffer,KEYS,1 << 17).fill(-1);
  const fast = fusedModule();
  if (fast) {
    new Float32Array(owned.buffer,PROBE,16).set(FUSED_PROBE);
    fused = new WebAssembly.Instance(fast,{env:{memory:owned}}).exports;
  }
  memory = owned; kernel = exports; refreshViews();
}
const metricScale = (typeof __RAPIER_JXL_UPLOAD__ !== 'undefined' && __RAPIER_JXL_UPLOAD__ === true) ? function (...args) {
  if (args[4] === 0 || args[6] === 0) colorsUsed = true;
  if (views.i32[(GAUSS + 248) >> 2]) throw fault('JXL_INTERNAL','ssimulacra2-arithmetic:upload');
  kernel.s2MetricScaleMeter(...args);
} : function (...args) {
  if (args[4] === 0 || args[6] === 0) colorsUsed = true;
  if (fused && fusedAllowed && fusedState > 0) {
    const failed = FAILED >> 2;
    views.i32[failed] = 0; fused.s2MetricScale(...args);
    if (!views.i32[failed]) return;
    fusedState = -2; fused = null;
  }
  kernel.s2MetricScale(...args);
};
function metricBand(...args) {
  if (args[7] === 0 || args[9] === 0) colorsUsed = true;
  if (fused?.s2MetricBand && fusedAllowed && fusedState > 0) {
    const failed = FAILED >> 2;
    views.i32[failed] = 0;
    const made = fused.s2MetricBand(...args);
    if (!views.i32[failed]) return made;
    fusedState = -2; fused = null;
  }
  return kernel.s2MetricBand(...args);
}
function metricBand2(...args) {
  if (args[7] === 0 || args[9] === 0 || args[11] === 0) colorsUsed = true;
  if (fused?.s2MetricBand2 && fusedAllowed && fusedState > 0) {
    const failed = FAILED >> 2;
    views.i32[failed] = 0;
    const made = fused.s2MetricBand2(...args);
    if (!views.i32[failed]) return made;
    fusedState = -2; fused = null;
  }
  return kernel.s2MetricBand2 ? kernel.s2MetricBand2(...args) : null;
}
function reserve(plan) {
  ready();
  if (plan.arenaBytes > memory.buffer.byteLength) {
    try { memory.grow(Math.ceil((plan.arenaBytes - memory.buffer.byteLength) / 65536)); }
    catch (cause) { throw Object.assign(fault('JXL_MEMORY','SSIMULACRA2 memory'),{cause}); }
  }
  refreshViews();
  dirtyEnd = Math.max(dirtyEnd,plan.arenaBytes);
}
const inputBytes = (input,n) => input.rgba ? n * 4 : n * 12;
function writeInput(input,at,n) {
  if (!at) return;
  if (input.rgba) views.u8.set(input.rgba.subarray(0,n * 4),at);
  else for (let c = 0; c < 3; c++) views.f32.set(input[c].subarray(0,n),(at >> 2) + c * n);
}
const arithmeticFlag = libjxl => { new Int32Array(memory.buffer,GAUSS + 248,1)[0] = libjxl ? 1 : 0; };
function copyGauss(g) {
  if (g === lastGauss) return;
  views.f32.set([...g.n2,...g.d1,...g.coefficients.flatMap(p => [...p.input,...p.previous,...p.previous2])],GAUSS >> 2);
  views.f32.set(g.taps,(GAUSS + 256) >> 2);
  lastGauss = g;
}
let linearLookup = null;
export function s2LinearTable() {
  if (!linearLookup) {
    const close = openMetricArena();
    try { ready(); linearLookup = new Float32Array(memory.buffer,LUT,256).slice(); } finally { close(); }
  }
  return linearLookup.slice();
}
let deviceTables = null;
export function s2DeviceTables(g) {
  if (deviceTables) return deviceTables;
  const close = openMetricArena();
  try {
    ready();
    const words = new Uint32Array(512);
    words.set(new Uint32Array(memory.buffer,LUT,256));
    words.set(new Uint32Array(g.taps.buffer, g.taps.byteOffset, 5),256);
    return deviceTables = words;
  } finally { close(); }
}
export function downsample(input,width,height,into = null) {
  const w = Math.ceil(width / 2), h = Math.ceil(height / 2), n = width * height, m = w * h;
  const plan = s2ArenaPlan({base}), source = plan.take(inputBytes(input,n)), output = plan.take(m * 12);
  reserve(plan); writeInput(input,source,n);
  kernel.s2MetricDown(width,height,source,input.rgba ? 0 : 1,LUT,output);
  const planes = into ? into.map(p => p.subarray(0,m)) : [0,1,2].map(() => new Float32Array(m));
  for (let c = 0; c < 3; c++) planes[c].set(new Float32Array(memory.buffer,output + c * m * 4,m));
  return {planes,width:w,height:h};
}
export function scaleBand(a,b,w,h,g,first,end,previous = null,from = null,libjxl = false,place = null) {
  const inputY = from ?? Math.min(h,Math.ceil((first + 4) / 4) * 4);
  const inputEnd = Math.min(h,Math.ceil((end + 4) / 4) * 4), inputH = inputEnd - inputY;
  const plan = ssimulacra2Layout(w,Math.max(1,inputH),{referenceRgba:!!a.rgba,distortedRgba:!!b.rgba,base});
  if (place) { plan.scratch = place.scratch0; plan.sums = place.sums0; }
  reserve(plan); copyGauss(g);
  if ((a.rgba || b.rgba) && !resident) views.i32.fill(-1,KEYS >> 2,(KEYS >> 2) + (1 << 17));
  writeInput(a,plan.reference,w * inputH); writeInput(b,plan.distorted,w * inputH);
  if (previous && !previous.resident) {
    if (previous.states) {
      const scratch = new Float32Array(memory.buffer,plan.scratch,plan.rowBytes >> 2);
      for (let i = 0; i < 15; i++) scratch.set(previous.states.subarray(i * 6 * w,(i + 1) * 6 * w),stateAt(i,w));
    } else new Uint8Array(memory.buffer,plan.scratch,plan.rowBytes).set(previous.scratch);
    new Float64Array(memory.buffer,plan.sums,18).set(previous.sums);
  }
  arithmeticFlag(libjxl);
  const made = metricBand(w,h,first,end,inputY,inputH,plan.reference,a.rgba ? 0 : 1,
    plan.distorted,b.rgba ? 0 : 1,LUT,GAUSS,plan.scratch,plan.sums,KEYS,VALUES);
  if (made !== inputEnd) throw fault('JXL_INTERNAL','ssimulacra2-arithmetic:rows-1');
  const sums = new Float64Array(memory.buffer,plan.sums,18).slice();
  return place ? {resident:true,output:0,sums} : {scratch:new Uint8Array(memory.buffer,plan.scratch,plan.rowBytes).slice(),sums};
}
export function scaleBandPair(a,b0,b1,w,h,g,first,end,previous0 = null,previous1 = null,from = null,place = null,libjxl = false) {
  ready();
  if (!kernel.s2MetricBand2 && !fused?.s2MetricBand2) return null;
  const inputY = from ?? Math.min(h,Math.ceil((first + 4) / 4) * 4);
  const inputEnd = Math.min(h,Math.ceil((end + 4) / 4) * 4), inputH = inputEnd - inputY;
  const plan = ssimulacra2Layout(w,Math.max(1,inputH),{referenceRgba:!!a.rgba,distortedRgba:!!b0.rgba,base});
  if (place && place.rowBytes !== plan.rowBytes || !place && (previous0?.resident || previous1?.resident))
    throw fault('JXL_INTERNAL','ssimulacra2-arithmetic:scale');
  const more = s2ArenaPlan({base:plan.arenaBytes}), distorted1 = more.take(plan.distortedBytes), scratch1 = place ? place.scratch1 : more.take(plan.rowBytes), sums1 = place ? place.sums1 : more.take(18 * 8);
  if (place) { plan.scratch = place.scratch0; plan.sums = place.sums0; }
  reserve({arenaBytes:more.arenaBytes}); copyGauss(g);
  if ((a.rgba || b0.rgba || b1.rgba) && !resident) views.i32.fill(-1,KEYS >> 2,(KEYS >> 2) + (1 << 17));
  writeInput(a,plan.reference,w * inputH); writeInput(b0,plan.distorted,w * inputH); writeInput(b1,distorted1,w * inputH);
  for (const [previous,scratch,sums] of [[previous0,plan.scratch,plan.sums],[previous1,scratch1,sums1]]) if (previous && !previous.resident) {
    if (previous.states) {
      const rows = new Float32Array(memory.buffer,scratch,plan.rowBytes >> 2);
      for (let i = 0; i < 15; i++) rows.set(previous.states.subarray(i * 6 * w,(i + 1) * 6 * w),stateAt(i,w));
    } else new Uint8Array(memory.buffer,scratch,plan.rowBytes).set(previous.scratch);
    new Float64Array(memory.buffer,sums,18).set(previous.sums);
  }
  arithmeticFlag(libjxl);
  const made = metricBand2(w,h,first,end,inputY,inputH,plan.reference,a.rgba ? 0 : 1,plan.distorted,b0.rgba ? 0 : 1,
    distorted1,b1.rgba ? 0 : 1,LUT,GAUSS,plan.scratch,plan.sums,scratch1,sums1,KEYS,VALUES);
  if (made === null) return null;
  if (made !== inputEnd) throw fault('JXL_INTERNAL','ssimulacra2-arithmetic:rows-2');
  if (place) return [plan.sums,sums1].map((sums,k) => ({resident:true,output:k,sums:new Float64Array(memory.buffer,sums,18).slice(),pair:true}));
  return [[plan.scratch,plan.sums],[scratch1,sums1]].map(([scratch,sums]) => ({scratch:new Uint8Array(memory.buffer,scratch,plan.rowBytes).slice(),
    sums:new Float64Array(memory.buffer,sums,18).slice(),pair:true}));
}
export function residentScratch(arena,place,k) {
  return new Uint8Array(arena.memory.buffer,k ? place.scratch1 : place.scratch0,place.rowBytes).slice();
}
export function pairState(first,second,w) {
  const states = second.states.slice();
  for (let c = 0; c < 3; c++) for (const k of [0,2]) states.set(first.states.subarray((c * 5 + k) * 6 * w,(c * 5 + k + 1) * 6 * w),(c * 5 + k) * 6 * w);
  return {states,sums:second.sums};
}
const BAND_RING = 16, stateAt = (i,w) => (6 * BAND_RING + 8 + i * (BAND_RING + 7) + BAND_RING) * w;
export function bandState({scratch,sums},w) {
  const all = new Float32Array(scratch.buffer,scratch.byteOffset,scratch.byteLength >> 2), states = new Float32Array(15 * 6 * w);
  for (let i = 0; i < 15; i++) states.set(all.subarray(stateAt(i,w),stateAt(i,w) + 6 * w),i * 6 * w);
  return {states,sums};
}
export function scaleSums(a,b,w,h,g,channels,keep,colors,channel = null,terms = null,scale = 0,libjxl = false) {
  const mask = channel === null ? 7 : 1 << channel;

  let cached = 0;
  for (let c = 0; c < 3; c++) if (channels?.[c]) cached |= 1 << c;
  const planes = resident?.planes[scale] ?? null;
  if (planes) return residentSums(a,b,w,h,g,channels,keep,colors,mask,cached,terms,planes,libjxl);
  const plan = ssimulacra2Layout(w,h,{channels:mask,cached,retain:keep ? mask : 0,map:!!terms,
    referenceRgba:!!a?.rgba,distortedRgba:!!b.rgba,base});
  const n = plan.pixels;
  reserve(plan); copyGauss(g);
  if ((a?.rgba || b.rgba) && colors !== lastColors) { views.i32.fill(-1,KEYS >> 2,(KEYS >> 2) + (1 << 17)); lastColors = colors; }
  writeInput(a,plan.reference,n); writeInput(b,plan.distorted,n);
  for (let c = 0; c < 3; c++) if (plan.caches[c] && channels?.[c])
    for (const [k,key] of ['p1','mu1','s11'].entries())
      new Float32Array(memory.buffer,plan.caches[c] + k * n * 4,n).set(channels[c][key]);
  arithmeticFlag(libjxl);
  metricScale(w,h,mask,plan.reference,a?.rgba ? 0 : 1,plan.distorted,b.rgba ? 0 : 1,LUT,GAUSS,
    ...plan.caches,plan.cachedMask,plan.scratch,plan.terms,plan.edgeTerms,plan.sums,KEYS,VALUES);
  if (terms) {
    terms.d.set(new Float64Array(memory.buffer,plan.terms,n));
    terms.dd.set(new Float64Array(memory.buffer,plan.edgeTerms,n));
  }
  return [0,1,2].map(c => ({sums:views.f64.slice((plan.sums >> 3) + c * 6,(plan.sums >> 3) + (c + 1) * 6),
    reference:keep && (mask & (1 << c)) && !channels?.[c]
      ? Object.fromEntries(['p1','mu1','s11'].map((key,k) => [key,new Float32Array(memory.buffer,plan.caches[c] + k * n * 4,n).slice()]))
      : null}));
}
function residentSums(a,b,w,h,g,channels,keep,colors,mask,cached,terms,planes,libjxl) {
  const plan = ssimulacra2Layout(w,h,{channels:mask,cached,map:!!terms,referenceRgba:!!a?.rgba,distortedRgba:!!b.rgba,
    base,resident:true});
  const n = plan.pixels;
  reserve(plan); copyGauss(g);
  if ((a?.rgba || b.rgba) && colors !== lastColors) { views.i32.fill(-1,KEYS >> 2,(KEYS >> 2) + (1 << 17)); lastColors = colors; }
  writeInput(a,plan.reference,n); writeInput(b,plan.distorted,n);
  const at = [0,1,2].map(c => mask & (1 << c) && (keep || cached & (1 << c)) ? planes[c] : 0);
  arithmeticFlag(libjxl);
  metricScale(w,h,mask,plan.reference,a?.rgba ? 0 : 1,plan.distorted,b.rgba ? 0 : 1,LUT,GAUSS,
    ...at,plan.cachedMask,plan.scratch,plan.terms,plan.edgeTerms,plan.sums,KEYS,VALUES);
  if (terms) {
    terms.d.set(new Float64Array(memory.buffer,plan.terms,n));
    terms.dd.set(new Float64Array(memory.buffer,plan.edgeTerms,n));
  }
  return [0,1,2].map(c => ({sums:views.f64.slice((plan.sums >> 3) + c * 6,(plan.sums >> 3) + (c + 1) * 6),
    reference:keep && (mask & (1 << c)) && !channels?.[c] ? {resident:true,bytes:n * 12} : null}));
}
export function gaussianCoefficients(gauss) {
  const f32 = Math.fround;
  return {radius: gauss.radius, taps: Float32Array.from(gauss.taps), n2: gauss.n2.map(f32), d1: gauss.d1.map(f32),
    coefficients: gauss.d1.map((d, i) => {
      const n = gauss.n2[i], d2 = d * d;
      return {input: [n, -d * n, d2 * n - n, -d2 * d * n + 2 * d * n].map(f32),
        previous: [-d, d2 - 1, -d2 * d + 2 * d, d2 * d2 - 3 * d2 + 1].map(f32),
        previous2: [-1, d, -d2 + 1, d2 * d - 2 * d].map(f32)};
    })};
}