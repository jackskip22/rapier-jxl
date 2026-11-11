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
let memory, kernel, fused, lastColors, lastGauss;

const PROBE = GAUSS + 176, FAILED = GAUSS + 240, u = 1 + 2 ** -12;
const PROBE_INPUT = [u, -u, 2 * u, u, u, u, u, -2 * u, -(1 + 2 ** -11), 1 + 2 ** -11, -(2 + 2 ** -10), 2 + 2 ** -10];
export const FUSED_PROBE = Float32Array.from([...PROBE_INPUT, ...[0, 1, 2, 3].map(i => PROBE_INPUT[i] * PROBE_INPUT[4 + i] + PROBE_INPUT[8 + i])]);
let fusedState = 0, fusedAllowed = true;
const fusedBytes = () => wasmBytes(S2_FUSED);
function fusedModule() {
  if (fusedState) return fusedState > 0 ? wasmModule('s2-fused', fusedBytes) : null;
  fusedState = -1;
  try {
    if (suppliedWasm() || !WebAssembly.validate(fusedBytes())) return null;
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
  if (fusedState || suppliedWasm()) return;
  try { if (WebAssembly.validate(fusedBytes())) await compileWasm('s2-fused', fusedBytes); } catch {}
}
export function fusedMetric(allow = fusedAllowed) {
  fusedAllowed = allow;
  return allow && !!fusedModule();
}

let base = S2_MEMORY.base, resident = null;
export function openMetricArena() {
  const previous = [memory,kernel,fused,lastColors,lastGauss,base,resident];
  memory = kernel = fused = lastColors = lastGauss = resident = null; base = S2_MEMORY.base;
  let closed = false;
  return () => { if (!closed) { [memory,kernel,fused,lastColors,lastGauss,base,resident] = previous; closed = true; } };
}

export function referenceArena(scales) {
  let cursor = S2_MEMORY.base;
  const planes = scales.map(({width, height, keep}) => {
    if (!keep) return null;
    return [0,1,2].map(() => { const at = cursor; cursor += Math.ceil(width * height * 12 / 16) * 16; return at; });
  });
  const arena = {memory:null,kernel:null,fused:null,lastGauss:null,planes,base:cursor};
  const free = pooled.pop() ?? weak.pop()?.deref();
  if (free) Object.assign(arena, free);
  return arena;
}
const pooled = [], weak = [];
let dropTimer = null;
const dropPool = () => { dropTimer = null; while (pooled.length) weak.push(new WeakRef(pooled.pop())); weak.splice(0, weak.length - 2); };
export function releaseReferenceArena(arena) {
  if (!arena?.memory) return;
  if (arena.base > S2_MEMORY.base) new Uint8Array(arena.memory.buffer, S2_MEMORY.base, arena.base - S2_MEMORY.base).fill(0);
  pooled.push({memory: arena.memory, kernel: arena.kernel, fused: arena.fused});
  arena.memory = arena.kernel = arena.fused = arena.lastGauss = null;
  if (pooled.length > 2) weak.push(new WeakRef(pooled.shift()));
  if (dropTimer) clearTimeout(dropTimer);
  dropTimer = setTimeout(dropPool, 1000);
  dropTimer.unref?.();
}
export function useReferenceArena(arena) {
  const previous = [memory,kernel,fused,lastColors,lastGauss,base,resident];
  [memory,kernel,fused,lastGauss] = [arena.memory,arena.kernel,arena.fused,arena.lastGauss];
  lastColors = null; base = arena.base; resident = arena;
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    if (memory) {
      new Uint8Array(memory.buffer,0,65536).fill(0);
      new Int32Array(memory.buffer,KEYS,1 << 17).fill(-1);
      new Uint8Array(memory.buffer,VALUES,(S2_MEMORY.base - VALUES)).fill(0);
      if (memory.buffer.byteLength > arena.base) new Uint8Array(memory.buffer,arena.base).fill(0);
    }
    [arena.memory,arena.kernel,arena.fused,arena.lastGauss] = [memory,kernel,fused,lastGauss];
    [memory,kernel,fused,lastColors,lastGauss,base,resident] = previous;
  };
}

function ready() {
  if (kernel) return;
  const module = kernelModule();
  let owned;
  try { owned = new WebAssembly.Memory({initial:Math.ceil(S2_MEMORY.base / 65536), maximum:S2_MEMORY.maximumPages}); }
  catch (cause) { throw Object.assign(fault('JXL_MEMORY','Cannot prepare SSIMULACRA2 memory.'),{cause}); }
  const exports = new WebAssembly.Instance(module,{env:{memory:owned}}).exports;
  exports.s2MetricInit(LUT);
  new Int32Array(owned.buffer,KEYS,1 << 17).fill(-1);
  const fast = fusedModule();
  if (fast) {
    new Float32Array(owned.buffer,PROBE,16).set(FUSED_PROBE);
    fused = new WebAssembly.Instance(fast,{env:{memory:owned}}).exports;
  }
  memory = owned; kernel = exports;
}
function metricScale(...args) {
  if (fused && fusedAllowed && fusedState > 0) {
    const failed = new Int32Array(memory.buffer,FAILED,1);
    failed[0] = 0; fused.s2MetricScale(...args);
    if (!failed[0]) return;
    fusedState = -2; fused = null;
  }
  kernel.s2MetricScale(...args);
}
function metricBand(...args) {
  if (fused?.s2MetricBand && fusedAllowed && fusedState > 0) {
    const failed = new Int32Array(memory.buffer,FAILED,1);
    failed[0] = 0;
    const made = fused.s2MetricBand(...args);
    if (!failed[0]) return made;
    fusedState = -2; fused = null;
  }
  return kernel.s2MetricBand(...args);
}
function metricBand2(...args) {
  if (fused?.s2MetricBand2 && fusedAllowed && fusedState > 0) {
    const failed = new Int32Array(memory.buffer,FAILED,1);
    failed[0] = 0;
    const made = fused.s2MetricBand2(...args);
    if (!failed[0]) return made;
    fusedState = -2; fused = null;
  }
  return kernel.s2MetricBand2 ? kernel.s2MetricBand2(...args) : null;
}
function reserve(plan) {
  ready();
  if (plan.arenaBytes <= memory.buffer.byteLength) return;
  try { memory.grow(Math.ceil((plan.arenaBytes - memory.buffer.byteLength) / 65536)); }
  catch (cause) { throw Object.assign(fault('JXL_MEMORY','Not enough memory for SSIMULACRA2.'),{cause}); }
}
const inputBytes = (input,n) => input.rgba ? n * 4 : n * 12;
function writeInput(input,at,n) {
  if (!at) return;
  if (input.rgba) new Uint8Array(memory.buffer,at,n * 4).set(input.rgba.subarray(0,n * 4));
  else for (let c = 0; c < 3; c++) new Float32Array(memory.buffer,at + c * n * 4,n).set(input[c].subarray(0,n));
}
function copyGauss(g) {
  if (g === lastGauss) return;
  new Float32Array(memory.buffer,GAUSS,42).set([...g.n2,...g.d1,...g.coefficients.flatMap(p => [...p.input,...p.previous,...p.previous2])]);
  lastGauss = g;
}
let deviceTables = null;
export function s2DeviceTables(g) {
  if (deviceTables) return deviceTables;
  const close = openMetricArena();
  try {
    ready();
    const words = new Uint32Array(512);
    words.set(new Uint32Array(memory.buffer,LUT,256));
    words.set(new Uint32Array(Float32Array.from([...g.n2,...g.d1,...g.coefficients.flatMap(p => [...p.input,...p.previous,...p.previous2])]).buffer),256);
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
export function scaleBand(a,b,w,h,g,first,end,previous = null,from = null) {
  const inputY = from ?? Math.min(h,Math.ceil((first + 4) / 4) * 4);
  const inputEnd = Math.min(h,Math.ceil((end + 4) / 4) * 4), inputH = inputEnd - inputY;
  const plan = ssimulacra2Layout(w,Math.max(1,inputH),{referenceRgba:!!a.rgba,distortedRgba:!!b.rgba,base});
  reserve(plan); copyGauss(g);
  new Int32Array(memory.buffer,KEYS,1 << 17).fill(-1);
  writeInput(a,plan.reference,w * inputH); writeInput(b,plan.distorted,w * inputH);
  if (previous) {
    if (previous.states) {
      const scratch = new Float32Array(memory.buffer,plan.scratch,plan.rowBytes >> 2);
      for (let i = 0; i < 15; i++) scratch.set(previous.states.subarray(i * 6 * w,(i + 1) * 6 * w),stateAt(i,w));
    } else new Uint8Array(memory.buffer,plan.scratch,plan.rowBytes).set(previous.scratch);
    new Float64Array(memory.buffer,plan.sums,18).set(previous.sums);
  }
  const made = metricBand(w,h,first,end,inputY,inputH,plan.reference,a.rgba ? 0 : 1,
    plan.distorted,b.rgba ? 0 : 1,LUT,GAUSS,plan.scratch,plan.sums,KEYS,VALUES);
  if (made !== inputEnd) throw fault('JXL_INTERNAL','SSIMULACRA2 row continuation did not consume its input.');
  return {scratch:new Uint8Array(memory.buffer,plan.scratch,plan.rowBytes).slice(),
    sums:new Float64Array(memory.buffer,plan.sums,18).slice()};
}
export function scaleBandPair(a,b0,b1,w,h,g,first,end,previous0 = null,previous1 = null,from = null) {
  ready();
  if (!kernel.s2MetricBand2 && !fused?.s2MetricBand2) return null;
  const inputY = from ?? Math.min(h,Math.ceil((first + 4) / 4) * 4);
  const inputEnd = Math.min(h,Math.ceil((end + 4) / 4) * 4), inputH = inputEnd - inputY;
  const plan = ssimulacra2Layout(w,Math.max(1,inputH),{referenceRgba:!!a.rgba,distortedRgba:!!b0.rgba,base});
  const more = s2ArenaPlan({base:plan.arenaBytes}), distorted1 = more.take(plan.distortedBytes), scratch1 = more.take(plan.rowBytes), sums1 = more.take(18 * 8);
  reserve({arenaBytes:more.arenaBytes}); copyGauss(g);
  new Int32Array(memory.buffer,KEYS,1 << 17).fill(-1);
  writeInput(a,plan.reference,w * inputH); writeInput(b0,plan.distorted,w * inputH); writeInput(b1,distorted1,w * inputH);
  for (const [previous,scratch,sums] of [[previous0,plan.scratch,plan.sums],[previous1,scratch1,sums1]]) if (previous) {
    if (previous.states) {
      const rows = new Float32Array(memory.buffer,scratch,plan.rowBytes >> 2);
      for (let i = 0; i < 15; i++) rows.set(previous.states.subarray(i * 6 * w,(i + 1) * 6 * w),stateAt(i,w));
    } else new Uint8Array(memory.buffer,scratch,plan.rowBytes).set(previous.scratch);
    new Float64Array(memory.buffer,sums,18).set(previous.sums);
  }
  const made = metricBand2(w,h,first,end,inputY,inputH,plan.reference,a.rgba ? 0 : 1,plan.distorted,b0.rgba ? 0 : 1,
    distorted1,b1.rgba ? 0 : 1,LUT,GAUSS,plan.scratch,plan.sums,scratch1,sums1,KEYS,VALUES);
  if (made === null) return null;
  if (made !== inputEnd) throw fault('JXL_INTERNAL','SSIMULACRA2 row continuation did not consume its input.');
  return [[plan.scratch,plan.sums],[scratch1,sums1]].map(([scratch,sums]) => ({scratch:new Uint8Array(memory.buffer,scratch,plan.rowBytes).slice(),
    sums:new Float64Array(memory.buffer,sums,18).slice(),pair:true}));
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
export function scaleSums(a,b,w,h,g,channels,keep,colors,channel = null,terms = null,scale = 0) {
  const mask = channel === null ? 7 : 1 << channel;
  let cached = 0;
  for (let c = 0; c < 3; c++) if (channels?.[c]) cached |= 1 << c;
  const planes = resident?.planes[scale] ?? null;
  if (planes) return residentSums(a,b,w,h,g,channels,keep,colors,mask,cached,terms,planes);
  const plan = ssimulacra2Layout(w,h,{channels:mask,cached,retain:keep ? mask : 0,map:!!terms,
    referenceRgba:!!a?.rgba,distortedRgba:!!b.rgba,base});
  const n = plan.pixels;
  reserve(plan); copyGauss(g);
  if (colors !== lastColors) { new Int32Array(memory.buffer,KEYS,1 << 17).fill(-1); lastColors = colors; }
  writeInput(a,plan.reference,n); writeInput(b,plan.distorted,n);
  for (let c = 0; c < 3; c++) if (plan.caches[c] && channels?.[c])
    for (const [k,key] of ['p1','mu1','s11'].entries())
      new Float32Array(memory.buffer,plan.caches[c] + k * n * 4,n).set(channels[c][key]);
  metricScale(w,h,mask,plan.reference,a?.rgba ? 0 : 1,plan.distorted,b.rgba ? 0 : 1,LUT,GAUSS,
    ...plan.caches,plan.cachedMask,plan.scratch,plan.terms,plan.edgeTerms,plan.sums,KEYS,VALUES);
  if (terms) {
    terms.d.set(new Float64Array(memory.buffer,plan.terms,n));
    terms.dd.set(new Float64Array(memory.buffer,plan.edgeTerms,n));
  }
  return [0,1,2].map(c => ({sums:new Float64Array(memory.buffer,plan.sums + c * 48,6).slice(),
    reference:keep && (mask & (1 << c)) && !channels?.[c]
      ? Object.fromEntries(['p1','mu1','s11'].map((key,k) => [key,new Float32Array(memory.buffer,plan.caches[c] + k * n * 4,n).slice()]))
      : null}));
}
function residentSums(a,b,w,h,g,channels,keep,colors,mask,cached,terms,planes) {
  const plan = ssimulacra2Layout(w,h,{channels:mask,cached,map:!!terms,referenceRgba:!!a?.rgba,distortedRgba:!!b.rgba,
    base,resident:true});
  const n = plan.pixels;
  reserve(plan); copyGauss(g);
  if (colors !== lastColors) { new Int32Array(memory.buffer,KEYS,1 << 17).fill(-1); lastColors = colors; }
  writeInput(a,plan.reference,n); writeInput(b,plan.distorted,n);
  const at = [0,1,2].map(c => mask & (1 << c) && (keep || cached & (1 << c)) ? planes[c] : 0);
  metricScale(w,h,mask,plan.reference,a?.rgba ? 0 : 1,plan.distorted,b.rgba ? 0 : 1,LUT,GAUSS,
    ...at,plan.cachedMask,plan.scratch,plan.terms,plan.edgeTerms,plan.sums,KEYS,VALUES);
  if (terms) {
    terms.d.set(new Float64Array(memory.buffer,plan.terms,n));
    terms.dd.set(new Float64Array(memory.buffer,plan.edgeTerms,n));
  }
  return [0,1,2].map(c => ({sums:new Float64Array(memory.buffer,plan.sums + c * 48,6).slice(),
    reference:keep && (mask & (1 << c)) && !channels?.[c] ? {resident:true,bytes:n * 12} : null}));
}
export function gaussianCoefficients(gauss) {
  const f32 = Math.fround;
  return {radius: gauss.radius, n2: gauss.n2.map(f32), d1: gauss.d1.map(f32),
    coefficients: gauss.d1.map((d, i) => {
      const n = gauss.n2[i], d2 = d * d;
      return {input: [n, -d * n, d2 * n - n, -d2 * d * n + 2 * d * n].map(f32),
        previous: [-d, d2 - 1, -d2 * d + 2 * d, d2 * d2 - 3 * d2 + 1].map(f32),
        previous2: [-1, d, -d2 + 1, d2 * d - 2 * d].map(f32)};
    })};
}

