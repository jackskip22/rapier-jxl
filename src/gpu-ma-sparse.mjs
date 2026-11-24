// SPDX-License-Identifier: MIT
import {INT_WGSL} from './int-ops.mjs';
import {gpuWait, gpuKernel, gpuAlloc, gpuUpload, gpuUni, gpuStep, gpuStage, gpuDestroy, gpuScoped, gpuSize, gpuAbort} from './gpu-kit.mjs';
import {maHistogramLayout} from './gpu-ma-counts.mjs';
import {MA_WINNER_WGSL} from './gpu-ma-price.mjs';
const U32 = 0xffffffff, TWO32 = 4294967296, NONE = U32, BAD = U32 - 1;
const shape = (ok, reason) => { if (!ok) throw Object.assign(new Error(reason), {code: 'MA_SPARSE_SHAPE'}); };
const limit = (ok, reason) => { if (!ok) throw Object.assign(new Error(reason), {code: 'MA_SPARSE_LIMIT'}); };
const abort = signal => { if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError'); };
const round4 = n => Math.ceil(n / 4) * 4;
const bytesOf = buffers => buffers.reduce((sum, b) => sum + b.size, 0);

const parameters =  `
struct Params {
  count: u32, kinds: u32, alphabet: u32, nodes: u32,
  pairs: u32, partColumns: u32, histStride: u32, reserved: u32,
}
@group(0) @binding(0) var<uniform> p: Params;
`;

const recordCode =  `
struct Record {
  column: u32, bin: u32, loSelected: u32, hiSelected: u32,
  loBits: vec2u, hiBits: vec2u,
}
fn absent() -> Record { return Record(0xffffffffu, 0u, 0u, 0u, vec2u(0u), vec2u(0u)); }
fn invalid() -> Record { return Record(0xfffffffeu, 0u, 0u, 0u, vec2u(0u), vec2u(0u)); }
fn less64(a: vec2u, b: vec2u) -> bool {
  let ah = bitcast<i32>(a.y); let bh = bitcast<i32>(b.y);
  return ah < bh || (ah == bh && a.x < b.x);
}` + MA_WINNER_WGSL;

const histShader = wg => INT_WGSL + parameters +  `
@group(0) @binding(1) var<storage, read> members: array<u32>;
@group(0) @binding(2) var<storage, read> symbols: array<u32>;
@group(0) @binding(3) var<storage, read> metadata: array<u32>;
@group(0) @binding(4) var<storage, read_write> hist: array<u32>;
@group(0) @binding(5) var<storage, read> table: array<vec2u>;
@group(0) @binding(6) var<storage, read> raw: array<u32>;
var<workgroup> counts: array<atomic<u32>, 256>;
var<workgroup> failed: atomic<u32>;
var<workgroup> sums: array<vec4u, ${wg}>;
var<workgroup> totals: array<u32, ${wg}>;
@compute @workgroup_size(${wg})
fn main(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_id) local: vec3u) {
  let node = group.x; let kind = group.y;
  if (node >= p.nodes || kind >= p.kinds) { return; }
  let first = metadata[node * 4u]; let n = metadata[node * 4u + 1u]; let nodeBase = metadata[node * 4u + 2u];
  let base = nodeBase + kind * p.alphabet;
  for (var s = local.x; s < 256u; s = s + ${wg}u) { atomicStore(&counts[s], 0u); }
  if (local.x == 0u) { atomicStore(&failed, 0u); }
  workgroupBarrier();
  for (var i = local.x; i < n; i = i + ${wg}u) {
    let sample = members[first + i];
    if (sample >= p.count) { atomicOr(&failed, 1u); continue; }
    let pos = kind * p.count + sample;
    let s = (symbols[pos >> 2u] >> ((pos & 3u) * 8u)) & 255u;
    if (s >= p.alphabet) { atomicOr(&failed, 1u); continue; }
    atomicAdd(&counts[s], 1u);
  }
  workgroupBarrier();
  var total = 0u; var tables = vec2u(0u); var raws = vec2u(0u);
  for (var s = local.x; s < p.alphabet; s = s + ${wg}u) {
    let v = atomicLoad(&counts[s]); hist[base + s] = v; total = total + v;
    tables = add64(tables, table[v]); raws = add64(raws, mul64(v, raw[s]));
  }
  sums[local.x] = vec4u(tables, raws); totals[local.x] = total;
  workgroupBarrier();
  for (var stride = ${wg / 2}u; stride != 0u; stride = stride >> 1u) {
    if (local.x < stride) {
      let a = sums[local.x]; let b = sums[local.x + stride];
      sums[local.x] = vec4u(add64(a.xy, b.xy), add64(a.zw, b.zw));
      totals[local.x] = totals[local.x] + totals[local.x + stride];
    }
    workgroupBarrier();
  }
  if (local.x == 0u) {
    let stats = nodeBase + p.kinds * p.alphabet + kind * 5u; let sums0 = sums[0];
    hist[stats] = sums0.x; hist[stats + 1u] = sums0.y;
    hist[stats + 2u] = sums0.z; hist[stats + 3u] = sums0.w;
    hist[stats + 4u] = select(0u, 1u, atomicLoad(&failed) != 0u || totals[0] != n);
  }
}
`;

const bucketShader = wg => parameters +  `
@group(0) @binding(1) var<storage, read> members: array<u32>;
@group(0) @binding(2) var<storage, read> indices: array<u32>;
@group(0) @binding(3) var<storage, read> metadata: array<u32>;
@group(0) @binding(4) var<storage, read_write> work: array<u32>;
var<workgroup> cursors: array<atomic<u32>, 256>;
var<workgroup> boundaries: array<u32, 257>;
@compute @workgroup_size(${wg})
fn main(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_id) local: vec3u) {
  let pair = group.x; if (pair >= p.pairs) { return; }
  let pm = p.nodes * 4u + pair * 12u;
  let node = metadata[pm]; let column = metadata[pm + 1u]; let bins = metadata[pm + 2u];
  let first = metadata[node * 4u]; let n = metadata[node * 4u + 1u];
  let bucket = metadata[pm + 4u]; let prefix = metadata[pm + 5u];
  let slots = metadata[pm + 8u]; let header = metadata[pm + 9u]; let capacity = metadata[pm + 10u];
  for (var b = local.x; b < 256u; b = b + ${wg}u) { atomicStore(&cursors[b], 0u); }
  workgroupBarrier();
  for (var i = local.x; i < n; i = i + ${wg}u) {
    let pos = column * p.count + members[first + i];
    let bin = (indices[pos >> 2u] >> ((pos & 3u) * 8u)) & 255u;
    atomicAdd(&cursors[bin], 1u);
  }
  workgroupBarrier();
  if (local.x == 0u) {
    var total = 0u; var used = 0u; var bad = false;
    boundaries[0] = 0u; work[prefix] = 0u;
    for (var b = 0u; b < bins; b = b + 1u) {
      let moved = atomicLoad(&cursors[b]);
      if (moved > n || total > n - min(moved, n)) { bad = true; }
      total = total + moved; boundaries[b + 1u] = total; work[prefix + b + 1u] = total;
      if (n >= 64u && b + 1u < bins && moved != 0u && total >= 24u && total <= n - 24u) {
        if (used >= capacity) { bad = true; }
        else { work[slots + used * 2u] = b; work[slots + used * 2u + 1u] = total; }
        used = used + 1u;
      }
    }
    for (var b = bins; b < 256u; b = b + 1u) { if (atomicLoad(&cursors[b]) != 0u) { bad = true; } }
    work[header] = min(used, capacity); work[header + 1u] = select(0u, 1u, bad || total != n);
  }
  workgroupBarrier();
  for (var b = local.x; b < bins; b = b + ${wg}u) { atomicStore(&cursors[b], boundaries[b]); }
  workgroupBarrier();
  for (var i = local.x; i < n; i = i + ${wg}u) {
    let sample = members[first + i]; let pos = column * p.count + sample;
    let bin = (indices[pos >> 2u] >> ((pos & 3u) * 8u)) & 255u;
    if (bin < bins) {
      let at = atomicAdd(&cursors[bin], 1u);
      if (at < n) { work[bucket + at] = sample; }
    }
  }
}
`;

const sweepShader = (wg, tileBins, alphabet) => INT_WGSL + parameters +  `
@group(0) @binding(1) var<storage, read> symbols: array<u32>;
@group(0) @binding(2) var<storage, read> metadata: array<u32>;
@group(0) @binding(3) var<storage, read> hist: array<u32>;
@group(0) @binding(4) var<storage, read_write> work: array<u32>;
@group(0) @binding(5) var<storage, read> table: array<vec2u>;
@group(0) @binding(6) var<storage, read> raw: array<u32>;
@group(0) @binding(7) var<storage, read> indices: array<u32>;
// A padded symbol stride avoids bank conflicts while forming symbol prefixes.
var<workgroup> counts: array<atomic<u32>, ${(tileBins + 1) * alphabet}>;
var<workgroup> failed: atomic<u32>;
var<workgroup> visited: atomic<u32>;
var<workgroup> binCount: u32;
@compute @workgroup_size(${wg})
fn main(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_id) local: vec3u) {
  let pair = group.x; let kind = group.y;
  if (pair >= p.pairs || kind >= p.kinds) { return; }
  let pm = p.nodes * 4u + pair * 12u;
  let node = metadata[pm]; let column = metadata[pm + 1u];
  if (local.x == 0u) { binCount = metadata[pm + 2u]; }
  let bins = workgroupUniformLoad(&binCount);
  let n = metadata[node * 4u + 1u]; let nodeBase = metadata[node * 4u + 2u];
  // Host validation gives table[c] = c*Q(c), 0<=Q<29*4096, and raw<=30*4096.
  // Counts in either child sum to <=n, so every nonnegative table/raw subtotal
  // and their combined bound is <=n*59*4096. For n<=16384 this is <=3,959,422,976
  // (<2^32); the x words alone are exact. Larger nodes keep the full u64 path.
  let narrow = n <= 16384u;
  let bucket = metadata[pm + 4u]; let prefix = metadata[pm + 5u];
  let lowBase = metadata[pm + 6u] + kind * p.alphabet; let prices = metadata[pm + 7u];
  let slots = metadata[pm + 8u]; let header = metadata[pm + 9u]; let capacity = metadata[pm + 10u];
  let full = nodeBase + kind * p.alphabet;
  let stats = nodeBase + p.kinds * p.alphabet + kind * 5u;
  let fullRaw = vec2u(hist[stats + 2u], hist[stats + 3u]);
  let used = work[header];
  if (local.x == 0u) {
    atomicStore(&failed, select(0u, 1u, work[header + 1u] != 0u || hist[stats + 4u] != 0u || used > capacity));
    atomicStore(&visited, 0u);
  }
  for (var s = local.x; s < p.alphabet; s = s + ${wg}u) { work[lowBase + s] = 0u; }
  workgroupBarrier();
  for (var tile = 0u; tile < bins; tile = tile + ${tileBins}u) {
    let tileEnd = min(tile + ${tileBins}u, bins); let width = tileEnd - tile;
    for (var cell = local.x; cell < ${(tileBins + 1) * alphabet}u; cell = cell + ${wg}u) { atomicStore(&counts[cell], 0u); }
    workgroupBarrier();
    let first = work[prefix + tile]; let end = work[prefix + tileEnd];
    if (first > end || end > n) { atomicOr(&failed, 1u); }
    else {
      for (var i = first + local.x; i < end; i = i + ${wg}u) {
        let sample = work[bucket + i];
        if (sample >= p.count) { atomicOr(&failed, 1u); continue; }
        let pos = kind * p.count + sample;
        let symbol = (symbols[pos >> 2u] >> ((pos & 3u) * 8u)) & 255u;
        let index = column * p.count + sample;
        let bin = (indices[index >> 2u] >> ((index & 3u) * 8u)) & 255u;
        if (symbol >= p.alphabet || bin < tile || bin >= tileEnd) { atomicOr(&failed, 1u); continue; }
        atomicAdd(&counts[symbol * ${tileBins + 1}u + bin - tile], 1u);
      }
    }
    workgroupBarrier();
    // The same invocation owns a symbol's global carry at every tile. Other
    // invocations price only the shared cumulative counts after the barrier.
    for (var s = local.x; s < p.alphabet; s = s + ${wg}u) {
      var low = work[lowBase + s]; let total = hist[full + s];
      for (var b = 0u; b < width; b = b + 1u) {
        let cell = s * ${tileBins + 1}u + b; let moved = atomicLoad(&counts[cell]);
        if (moved > n || low > n - min(moved, n)) { atomicOr(&failed, 1u); }
        low = low + moved;
        if (low > total) { atomicOr(&failed, 1u); }
        // AS168_DIAGNOSTIC_CUMULATIVE
        atomicStore(&counts[cell], low);
      }
      work[lowBase + s] = low;
    }
    workgroupBarrier();
    for (var b = local.x; b < width; b = b + ${wg}u) {
      let bin = tile + b; let lowCount = work[prefix + bin + 1u]; let previous = work[prefix + bin];
      if (previous > lowCount || lowCount > n) { atomicOr(&failed, 1u); continue; }
      if (n < 64u || bin + 1u >= bins || previous == lowCount || lowCount < 24u || lowCount > n - 24u) { continue; }
      // Bucket slots are sorted by original physical bin. Look up this cut
      // without introducing a shared counter or changing that wire layout.
      var left = 0u; var right = min(used, capacity);
      while (left < right) {
        let middle = left + (right - left) / 2u;
        if (work[slots + middle * 2u] < bin) { left = middle + 1u; } else { right = middle; }
      }
      if (left >= used || left >= capacity) { atomicOr(&failed, 1u); continue; }
      if (work[slots + left * 2u] != bin || work[slots + left * 2u + 1u] != lowCount) { atomicOr(&failed, 1u); continue; }
      var lowTable = vec2u(0u); var highTable = vec2u(0u);
      var lowRaw = vec2u(0u); var summedLow = 0u; var summedHigh = 0u;
      for (var s = 0u; s < p.alphabet; s = s + 1u) {
        let low = atomicLoad(&counts[s * ${tileBins + 1}u + b]); let total = hist[full + s];
        if (low > total || total > n) { atomicOr(&failed, 1u); continue; }
        // table[0] is validated as zero; preserve the low<=total check above.
        if (total == 0u) { continue; }
        let high = total - low; summedLow = summedLow + low; summedHigh = summedHigh + high;
        if (narrow) {
          lowTable.x = lowTable.x + table[low].x; highTable.x = highTable.x + table[high].x;
          lowRaw.x = lowRaw.x + low * raw[s];
        } else {
          lowTable = add64(lowTable, table[low]); highTable = add64(highTable, table[high]);
          lowRaw = add64(lowRaw, mul64(low, raw[s]));
        }
      }
      if (summedLow != lowCount || summedHigh != n - lowCount) { atomicOr(&failed, 1u); }
      let highRaw = add64(fullRaw, neg64(lowRaw));
      let lo = add64(add64(table[lowCount], neg64(lowTable)), lowRaw);
      let hi = add64(add64(table[n - lowCount], neg64(highTable)), highRaw);
      let dest = prices + (kind * capacity + left) * 4u;
      work[dest] = lo.x; work[dest + 1u] = lo.y;
      work[dest + 2u] = hi.x; work[dest + 3u] = hi.y;
      atomicAdd(&visited, 1u);
    }
    workgroupBarrier();
  }
  for (var s = local.x; s < p.alphabet; s = s + ${wg}u) {
    if (work[lowBase + s] != hist[full + s]) { atomicOr(&failed, 1u); }
  }
  workgroupBarrier();
  if (local.x == 0u) {
    work[header + 2u + kind] = select(0u, 1u, atomicLoad(&failed) != 0u || atomicLoad(&visited) != used);
  }
}
`;

const chooseShader = wg => INT_WGSL + parameters + recordCode +  `
@group(0) @binding(1) var<storage, read> metadata: array<u32>;
@group(0) @binding(2) var<storage, read> work: array<u32>;
@group(0) @binding(3) var<storage, read_write> chosen: array<Record>;
var<workgroup> choices: array<Record, ${wg}>;
@compute @workgroup_size(${wg})
fn main(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_id) local: vec3u) {
  let pair = group.x; if (pair >= p.pairs) { return; }
  let pm = p.nodes * 4u + pair * 12u; let node = metadata[pm]; let column = metadata[pm + 1u]; let bins = metadata[pm + 2u];
  let n = metadata[node * 4u + 1u]; let prices = metadata[pm + 7u];
  let slots = metadata[pm + 8u]; let header = metadata[pm + 9u]; let capacity = metadata[pm + 10u];
  let used = work[header]; var bad = work[header + 1u] != 0u || used > capacity;
  for (var k = 0u; k < p.kinds; k = k + 1u) { if (work[header + 2u + k] != 0u) { bad = true; } }
  var best = absent();
  if (bad) { best = invalid(); }
  else {
    for (var i = local.x; i < used; i = i + ${wg}u) {
      let bin = work[slots + i * 2u]; let low = work[slots + i * 2u + 1u];
      if (n < 64u || bin + 1u >= bins || low < 24u || low > n - 24u) { best = invalid(); continue; }
      var candidate = Record(column, bin, 0u, 0u, vec2u(0u), vec2u(0u));
      for (var k = 0u; k < p.kinds; k = k + 1u) {
        let at = prices + (k * capacity + i) * 4u;
        let lo = vec2u(work[at], work[at + 1u]); let hi = vec2u(work[at + 2u], work[at + 3u]);
        if (k == 0u || less64(lo, candidate.loBits)) { candidate.loBits = lo; candidate.loSelected = k; }
        if (k == 0u || less64(hi, candidate.hiBits)) { candidate.hiBits = hi; candidate.hiSelected = k; }
      }
      best = winner(best, candidate);
    }
  }
  choices[local.x] = best; workgroupBarrier();
  for (var stride = ${wg / 2}u; stride != 0u; stride = stride >> 1u) {
    if (local.x < stride) { choices[local.x] = winner(choices[local.x], choices[local.x + stride]); }
    workgroupBarrier();
  }
  if (local.x == 0u) { chosen[pair] = choices[0]; }
}
`;

const mergeShader = wg => INT_WGSL + parameters + recordCode +  `
@group(0) @binding(1) var<storage, read> chosen: array<Record>;
@group(0) @binding(2) var<storage, read_write> best: array<Record>;
var<workgroup> choices: array<Record, ${wg}>;
@compute @workgroup_size(${wg})
fn main(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_id) local: vec3u) {
  if (group.x >= p.nodes) { return; }
  var record = absent();
  for (var c = local.x; c < p.partColumns; c = c + ${wg}u) { record = winner(record, chosen[group.x * p.partColumns + c]); }
  choices[local.x] = record; workgroupBarrier();
  for (var stride = ${wg / 2}u; stride != 0u; stride = stride >> 1u) {
    if (local.x < stride) { choices[local.x] = winner(choices[local.x], choices[local.x + stride]); }
    workgroupBarrier();
  }
  if (local.x == 0u) { best[group.x] = winner(best[group.x], choices[0]); }
}
`;

export async function createMASparseProposalBatch(device, samples, prices, {signal} = {}) {
  const started = performance.now(), made = [], live = new Set(); let destroyed = false, busy = false;
  abort(signal);
  const layout = maHistogramLayout(samples), {count, kinds, alphabet} = layout;
  shape(count < 2 ** 29, 'Canonical Wasm32 table domain requires count < 2^29');
  const limits = device.limits;
  const storageBytes = Math.floor(Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize, U32) / 16) * 16;
  const groups = limits.maxComputeWorkgroupsPerDimension;
  const available = Math.min(256, limits.maxComputeInvocationsPerWorkgroup, limits.maxComputeWorkgroupSizeX,
    Math.floor(limits.maxComputeWorkgroupStorageSize / 32),
    Math.floor((limits.maxComputeWorkgroupStorageSize - 1040) / 20));
  limit(Number.isSafeInteger(storageBytes) && storageBytes >= 32 && Number.isInteger(groups) && groups >= kinds && available >= 1,
    'Unusable device compute/storage limits');
  limit(limits.maxComputeWorkgroupStorageSize >= 2064 && limits.maxStorageBuffersPerShaderStage >= 7 &&
    limits.maxUniformBufferBindingSize >= 32, 'Sparse stages require 2064 workgroup bytes, seven storage bindings and32 uniform bytes');
  let wg = 1; while (wg * 2 <= available) wg *= 2;
  const tileStorageBytes = Math.floor((limits.maxComputeWorkgroupStorageSize - 48) / 16) * 16;
  const tileCapacity = Math.min(256, Math.floor(tileStorageBytes / (alphabet * 4)) - 1);
  limit(tileCapacity >= 1, 'One padded symbol-count tile exceeds the device workgroup storage limit');
  let tileBins = 1; while (tileBins * 2 <= tileCapacity) tileBins *= 2;
  limit(gpuSize(count * kinds) <= storageBytes && gpuSize(count * layout.columns.length) <= storageBytes &&
    gpuSize((count + 1) * 8) <= storageBytes && gpuSize(alphabet * 4) <= storageBytes,
    'An immutable symbol/bin/table buffer exceeds an actual device binding limit');
  shape(prices?.table instanceof Float64Array && prices.table.length >= count + 1 &&
    prices.rawPrice instanceof Float64Array && prices.rawPrice.length === alphabet, 'Canonical f64 integer table/raw arrays required');
  const table = prices.table.slice(0, count + 1), raw = prices.rawPrice.slice();
  const maxQ = (32 - Math.clz32(count)) * 4096 - 1; let previousQ = 0;
  shape(table[0] === 0, 'Canonical entropy table must start at zero');
  for (let n = 1; n <= count; n++) {
    const q = table[n] / n;
    shape(Number.isSafeInteger(table[n]) && Number.isInteger(q) && q >= previousQ && q <= maxQ,
      'Entropy table is outside the exact monotone Q12 domain'); previousQ = q;
  }
  for (const value of raw) shape(Number.isSafeInteger(value) && value >= 0 && value <= 30 * 4096 && value % 4096 === 0,
    'Raw prices are outside the canonical integer Q12 domain');
  const packedTable = new Uint32Array((count + 1) * 2);
  for (let n = 0; n <= count; n++) { packedTable[n * 2] = table[n]; packedTable[n * 2 + 1] = Math.floor(table[n] / TWO32); }
  const packedRaw = Uint32Array.from(raw);
  const symbols = new Uint8Array(round4(kinds * count)), indices = new Uint8Array(round4(layout.columns.length * count));
  for (let k = 0; k < kinds; k++) symbols.set(samples.symbolSets[k], k * count);
  for (let c = 0; c < layout.columns.length; c++) indices.set(samples.columns[c].indices, c * count);
  const activeColumns = layout.columns.filter(c => c.bins > 0);
  const histStride = kinds * (alphabet + 5);
  const slotCapacity = (n, bins) => n >= 64 ? Math.min(bins - 1, n - 47) : 0;
  const pairWords = (n, bins) => n + bins + 1 + kinds * alphabet + 4 * kinds * slotCapacity(n, bins)
    + 2 * slotCapacity(n, bins) + kinds + 2;
  const fits = words => Number.isSafeInteger(words) && words >= 0 && words <= U32 && gpuSize(words * 4) <= storageBytes;
  const validationAndPackMs = performance.now() - started;
  let kernels, symbolGpu, indexGpu, tableGpu, rawGpu, setup;
  try {
    await gpuScoped(device, 'sparse MA setup', async () => {
      await gpuAbort(signal, async wait => {
        const at = performance.now();
        kernels = await wait(Promise.all([
          gpuKernel(device, `ma-sparse-hist-v2-wg${wg}`, histShader(wg), wg),
          gpuKernel(device, `ma-sparse-bucket-v1-wg${wg}`, bucketShader(wg), wg),
          gpuKernel(device, `ma-sparse-sweep-v4-wg${wg}-a${alphabet}-b${tileBins}`, sweepShader(wg, tileBins, alphabet), wg),
          gpuKernel(device, `ma-sparse-choose-v1-wg${wg}`, chooseShader(wg), wg),
          gpuKernel(device, `ma-sparse-merge-v1-wg${wg}`, mergeShader(wg), wg),
        ]));
        const pipelineMs = performance.now() - at; abort(signal);
        const uploadAt = performance.now(), alloc = gpuAlloc(device, made);
        symbolGpu = gpuUpload(device, alloc, symbols); indexGpu = gpuUpload(device, alloc, indices);
        tableGpu = gpuUpload(device, alloc, packedTable); rawGpu = gpuUpload(device, alloc, packedRaw);
        await wait(gpuWait(device, device.queue.onSubmittedWorkDone())); abort(signal);
        setup = {validationAndPackMs, pipelineMs, uploadAndWaitMs: performance.now() - uploadAt,
          uploadedBytes: symbols.byteLength + indices.byteLength + packedTable.byteLength + packedRaw.byteLength,
          residentLogicalBufferBytes: bytesOf(made), workgroup: wg, storageBindingLimitBytes: storageBytes,
          maxComputeWorkgroupsPerDimension: groups, maxComputeWorkgroupStorageSize: limits.maxComputeWorkgroupStorageSize,
          tileBins, sweepWorkgroupStorageBytes: Math.ceil((tileBins + 1) * alphabet / 4) * 16 + 48,
          histogramWorkgroupStorageBytesUpperBound: 1040 + wg * 16 + Math.ceil(wg / 4) * 16,
          integerPriceUnit: 'Q12 u32 pairs', histogramReadbackBytes: 0,
          cachePolicy: 'Immutable symbols, bins and canonical prices uploaded once per session. Node histograms, buckets and prices rebuilt for every batch; no member-count or proposal cache.',
          pipelineScope: 'Canonical gpuKernel cache on the supplied device; pipelineMs includes cache lookup or actual creation, not an assumed cold compilation.',
          algorithm: 'cooperative node histograms; member buckets; tiled cumulative symbol counts; cut choice; column merge'};
      });
    });
    setup.completeWallMs = performance.now() - started;
    const residentBytes = bytesOf(made);
    const session = {
      layout, setup, residentBytes,
      async proposals(suppliedNodes, {signal: runSignal} = {}) {
        shape(!destroyed && !busy, 'Sparse session is destroyed or already owns a batch');
        const batchStart = performance.now(); abort(runSignal);
        shape(Array.isArray(suppliedNodes), 'Nodes must be an array');
        const ids = new Set();
        const nodes = suppliedNodes.map(node => {
          shape(typeof node?.id === 'string' && node.id.length > 0 && !ids.has(node.id), 'Node IDs must be unique nonempty strings');
          ids.add(node.id);
          shape(node.members instanceof Uint32Array && node.members.length <= count, 'Node membership exceeds the canonical sample domain');
          const members = node.members.slice();
          for (const sample of members) shape(sample < count, 'Member ID exceeds the immutable sample population');
          return {id: node.id, members};
        });
        const validationMs = performance.now() - batchStart;
        const stats = {algorithm: 'sparse-tiled-counts-v3', tileBins, dispatches: 0, stageDispatches: {hist: 0, bucket: 0, sweep: 0, choose: 0, merge: 0},
          outputChunks: 0, columnParts: 0, bandCompletionWaits: 0, bandCompletionWaitWallMs: 0,
          nodeGroups: [], memberUploadBytes: 0, metadataUploadBytes: 0,
          uploadedBytes: 0, readbackBytes: 0, proposalReadbackBytes: 0, histogramReadbackBytes: 0,
          immutableUploadsInBatch: 0, residentLogicalBufferBytes: residentBytes, peakLogicalBufferBytes: residentBytes,
          allocatedTransientBytes: 0, destroyedTransientBytes: 0, liveTransientBytesAtFinish: 0,
          peakWorkArenaBytes: 0, totalMemberOccurrences: nodes.reduce((s, n) => s + n.members.length, 0),
          nodeCount: nodes.length, structuralBelow64Nodes: nodes.filter(n => n.members.length < 64).length,
          noActiveColumns: activeColumns.length === 0};
        shape(Number.isSafeInteger(stats.totalMemberOccurrences), 'Combined member population is not exactly indexable');
        const results = [];
        const account = () => {
          const current = [...live].reduce((sum, list) => sum + bytesOf(list), 0);
          stats.peakLogicalBufferBytes = Math.max(stats.peakLogicalBufferBytes, residentBytes + current);
          stats.liveTransientBytesAtFinish = current;
        };
        const newOwner = () => { const list = []; live.add(list); return list; };
        const free = list => { if (!live.has(list)) return; stats.destroyedTransientBytes += bytesOf(list); gpuDestroy(list); live.delete(list); account(); };
        const ownerAllocator = list => {
          const alloc = gpuAlloc(device, list);
          return (...args) => { const b = alloc(...args); stats.allocatedTransientBytes += b.size; account(); return b; };
        };
        const alive = () => { abort(runSignal); shape(!destroyed, 'Sparse session was destroyed during its batch'); };
        busy = true;
        try {
          await gpuScoped(device, 'sparse MA exact proposals', async () => {
            for (let firstNode = 0; firstNode < nodes.length;) {
              alive(); let endNode = firstNode, membersCount = 0;
              const byColumn = activeColumns.map(() => 0);
              while (endNode < nodes.length) {
                const n = nodes[endNode].members.length, population = endNode - firstNode + 1;
                const nextColumns = byColumn.map((words, c) => words + pairWords(n, activeColumns[c].bins));
                if (population > groups || !fits(population * histStride) ||
                    !fits(membersCount + n) || !fits(population * 16) || !fits(population * 8) || nextColumns.some(words => !fits(words))) break;
                membersCount += n; nextColumns.forEach((words, c) => { byColumn[c] = words; }); endNode++;
              }
              limit(endNode > firstNode, 'A single node/column exceeds actual sparse buffer or dispatch limits');
              const selected = nodes.slice(firstNode, endNode), population = selected.length;
              const owned = newOwner(), alloc = ownerAllocator(owned);
              const groupInfo = {firstNode, nodes: population, members: membersCount, columnParts: 0, pairCount: 0,
                slotCapacity: 0, workArenaBytesTotal: 0, peakWorkArenaBytes: 0,
                bandCompletionWaits: 0, bandCompletionWaitWallMs: 0, finalReadbackBytes: population * 32};
              stats.nodeGroups.push(groupInfo);
              try {
                const members = new Uint32Array(Math.max(1, membersCount)), headers = new Uint32Array(population * 4);
                let cursor = 0;
                selected.forEach((node, i) => { headers.set([cursor, node.members.length, i * histStride, 0], i * 4);
                  members.set(node.members, cursor); cursor += node.members.length; });
                const initial = new Uint32Array(population * 8);
                for (let i = 0; i < population; i++) initial[i * 8] = NONE;
                const memberGpu = gpuUpload(device, alloc, members), nodeMeta = gpuUpload(device, alloc, headers);
                const histGpu = alloc(population * histStride * 4);
                const bestGpu = gpuUpload(device, alloc, initial, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
                stats.memberUploadBytes += members.byteLength; stats.metadataUploadBytes += headers.byteLength;
                stats.uploadedBytes += members.byteLength + headers.byteLength + initial.byteLength;
                const seedParams = gpuUni(device, alloc, [count, kinds, alphabet, population, 0, 0, histStride, 0]);
                stats.metadataUploadBytes += 32; stats.uploadedBytes += 32;
                let encoder = device.createCommandEncoder();
                gpuStep(device, encoder, kernels[0], [seedParams, memberGpu, symbolGpu, nodeMeta, histGpu, tableGpu, rawGpu], population, kinds);
                stats.dispatches++; stats.stageDispatches.hist++;
                device.queue.submit([encoder.finish()]);
                for (let firstColumn = 0; firstColumn < activeColumns.length;) {
                  alive(); let lastColumn = firstColumn, words = 0;
                  while (lastColumn < activeColumns.length) {
                    const nextWords = words + byColumn[lastColumn], columns = lastColumn - firstColumn + 1, pairs = population * columns;
                    if (pairs > groups || !fits(nextWords) ||
                        !fits(population * 4 + pairs * 12) || !fits(pairs * 8)) break;
                    words = nextWords; lastColumn++;
                  }
                  limit(lastColumn > firstColumn, 'No active column fits the actual sparse part limits');
                  const partColumns = activeColumns.slice(firstColumn, lastColumn), pairs = population * partColumns.length;
                  const transient = newOwner(), partAlloc = ownerAllocator(transient);
                  try {
                    const metadata = new Uint32Array(population * 4 + pairs * 12); metadata.set(headers);
                    let at = 0, pair = 0, slotsTotal = 0;
                    for (let node = 0; node < population; node++) for (const column of partColumns) {
                      const n = selected[node].members.length, cap = slotCapacity(n, column.bins);
                      const bucket = at; at += n;
                      const prefix = at; at += column.bins + 1;
                      const low = at; at += kinds * alphabet;
                      const pricesAt = at; at += kinds * cap * 4;
                      const slots = at; at += cap * 2;
                      const header = at; at += kinds + 2;
                      metadata.set([node, column.column, column.bins, 0, bucket, prefix, low, pricesAt, slots, header, cap, 0], population * 4 + pair * 12);
                      pair++; slotsTotal += cap;
                    }
                    shape(at === words && pair === pairs, 'Sparse arena planning and exact offsets differ');
                    const metaGpu = gpuUpload(device, partAlloc, metadata), workGpu = partAlloc(words * 4), chosenGpu = partAlloc(pairs * 32);
                    const params = gpuUni(device, partAlloc, [count, kinds, alphabet, population, pairs, partColumns.length, histStride, 0]);
                    stats.metadataUploadBytes += metadata.byteLength + 32; stats.uploadedBytes += metadata.byteLength + 32;
                    groupInfo.columnParts++; groupInfo.pairCount += pairs; groupInfo.slotCapacity += slotsTotal;
                    groupInfo.workArenaBytesTotal += workGpu.size; groupInfo.peakWorkArenaBytes = Math.max(groupInfo.peakWorkArenaBytes, workGpu.size);
                    stats.peakWorkArenaBytes = Math.max(stats.peakWorkArenaBytes, workGpu.size);
                    encoder = device.createCommandEncoder();
                    gpuStep(device, encoder, kernels[1], [params, memberGpu, indexGpu, metaGpu, workGpu], pairs, 1);
                    gpuStep(device, encoder, kernels[2], [params, symbolGpu, metaGpu, histGpu, workGpu, tableGpu, rawGpu, indexGpu], pairs, kinds);
                    gpuStep(device, encoder, kernels[3], [params, metaGpu, workGpu, chosenGpu], pairs, 1);
                    gpuStep(device, encoder, kernels[4], [params, chosenGpu, bestGpu], population, 1);
                    device.queue.submit([encoder.finish()]);
                    stats.dispatches += 4; stats.columnParts++;
                    for (const key of ['bucket', 'sweep', 'choose', 'merge']) stats.stageDispatches[key]++;
                    if (lastColumn < activeColumns.length) {
                      const waitAt = performance.now();
                      await gpuAbort(runSignal, wait => wait(gpuWait(device, device.queue.onSubmittedWorkDone())));
                      alive();
                      const elapsed = performance.now() - waitAt;
                      stats.bandCompletionWaits++; stats.bandCompletionWaitWallMs += elapsed;
                      groupInfo.bandCompletionWaits++; groupInfo.bandCompletionWaitWallMs += elapsed;
                      free(transient);
                    }
                  } catch (error) { free(transient); throw error; }
                  firstColumn = lastColumn;
                }
                alive(); const readAt = performance.now(); encoder = device.createCommandEncoder();
                const [map, take] = gpuStage(device, alloc, encoder, [[bestGpu, 0, population * 32]], 'ma-sparse-records');
                account(); device.queue.submit([encoder.finish()]);
                const buffers = await gpuAbort(runSignal, async wait => { await wait(map()); const result = take(); await wait(gpuWait(device, device.queue.onSubmittedWorkDone())); return result; });
                alive(); groupInfo.finishReadbackWallMs = performance.now() - readAt;
                const values = new Uint32Array(buffers[0]);
                shape(values.length === population * 8, 'Sparse proposal readback length differs');
                for (let i = 0; i < population; i++) {
                  const pos = i * 8, column = values[pos], node = selected[i];
                  if (column === BAD) throw Object.assign(new Error('Sparse device conservation or price state differs for ' + node.id), {code: 'MA_SPARSE_COUNTS'});
                  if (column === NONE) { results.push({id: node.id, total: node.members.length, record: null}); continue; }
                  const bin = values[pos + 1], loSelected = values[pos + 2], hiSelected = values[pos + 3];
                  const loBits = values[pos + 4] + values[pos + 5] * TWO32, hiBits = values[pos + 6] + values[pos + 7] * TWO32;
                  shape(node.members.length >= 64 && column < layout.columns.length && layout.columns[column].bins > 0 &&
                    bin < layout.columns[column].bins - 1 && loSelected < kinds && hiSelected < kinds &&
                    Number.isSafeInteger(loBits) && Number.isSafeInteger(hiBits), 'Sparse proposal is outside the canonical integer ABI');
                  results.push({id: node.id, total: node.members.length, record: {column, bin, loSelected, hiSelected, loBits, hiBits}});
                }
                stats.readbackBytes += population * 32; stats.proposalReadbackBytes += population * 32; stats.outputChunks++;
              } finally {
                for (const list of [...live]) free(list);
              }
              firstNode = endNode;
            }
          });
          alive(); shape(results.length === nodes.length, 'Sparse batch omitted a node record');
          account();
          return {results, layout, timing: {completeWallMs: performance.now() - batchStart, validationMs,
            scope: 'Immutable inputs/table already resident; includes member snapshots/uploads, all five GPU stages, final32B/node map, unpack and transient destruction. Canonical CPU split consumption is outside this call.'}, memory: stats};
        } finally { for (const list of [...live]) free(list); busy = false; }
      },
      destroy() { if (destroyed) return; destroyed = true; for (const list of live) gpuDestroy(list); live.clear(); gpuDestroy(made); },
    };
    return session;
  } catch (error) { gpuDestroy(made); throw error; }
}

