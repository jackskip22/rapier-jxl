// SPDX-License-Identifier: MIT
import {INT_WGSL} from './int-ops.mjs';
import {gpuWait, gpuKernel, gpuAlloc, gpuUpload, gpuUni, gpuStep, gpuStage, gpuDestroy, gpuScoped, gpuSize, gpuAbort} from './gpu-kit.mjs';

const U32 = 0xffffffff, TWO32 = 4294967296, NONE = U32, BAD = U32 - 1;
const shape = (ok, message) => { if (!ok) throw Object.assign(new Error(message), {code: 'MA_PRICE_SHAPE'}); };
const limit = (ok, message) => { if (!ok) throw Object.assign(new Error(message), {code: 'MA_PRICE_LIMIT'}); };
const aborted = signal => { if (signal?.aborted) throw signal.reason; };
const sumBytes = buffers => buffers.reduce((sum, buffer) => sum + buffer.size, 0);
const wordPairs = values => {
  const words = new Uint32Array(values.length * 2);
  for (let i = 0; i < values.length; i++) {
    words[i * 2] = values[i]; words[i * 2 + 1] = Math.floor(values[i] / TWO32);
  }
  return words;
};

const parameters =  `
struct Params {
  nodes: u32, kinds: u32, alphabet: u32, firstColumn: u32,
  columns: u32, countFirstCell: u32, countNodeCells: u32, priceFirstWord: u32,
  priceNodeWords: u32, seedColumn: u32, reserved0: u32, reserved1: u32,
}
@group(0) @binding(0) var<uniform> p: Params;
`;

export const MA_WINNER_WGSL =  `fn winner(a: Record, b: Record) -> Record {
  // Invalid resident counts poison the group; they never become a priced row.
  if (a.column == 0xfffffffeu) { return a; }
  if (b.column == 0xfffffffeu) { return b; }
  if (a.column == 0xffffffffu) { return b; }
  if (b.column == 0xffffffffu) { return a; }
  let ac = add64(a.loBits, a.hiBits); let bc = add64(b.loBits, b.hiBits);
  if (less64(bc, ac)) { return b; }
  if (all(ac == bc) && (b.column < a.column || (b.column == a.column && b.bin < a.bin))) { return b; }
  return a;
}
`;

const records =  `
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

const seedShader = workgroup => parameters +  `
@group(0) @binding(1) var<storage, read> counts: array<u32>;
@group(0) @binding(2) var<storage, read> columns: array<vec4u>;
@group(0) @binding(3) var<storage, read> totals: array<u32>;
@group(0) @binding(4) var<storage, read_write> reference: array<u32>;
@compute @workgroup_size(${workgroup})
fn main(@builtin(global_invocation_id) at: vec3u) {
  let cells = p.kinds * p.alphabet;
  if (at.x >= cells || at.y >= p.nodes) { return; }
  let n = totals[at.y]; let column = columns[p.seedColumn];
  let kind = at.x / p.alphabet; let symbol = at.x % p.alphabet;
  let base = at.y * p.countNodeCells + column.x - p.countFirstCell;
  var hist = 0u; var bad = false;
  for (var b = 0u; b < column.y; b = b + 1u) {
    let v = counts[base + (kind * column.y + b) * p.alphabet + symbol];
    if (v > n || hist > n - min(v, n)) { bad = true; }
    if (!bad) { hist = hist + v; }
  }
  reference[at.y * cells + at.x] = select(hist, 0xffffffffu, bad);
}
`;

const contributionShader = workgroup => INT_WGSL + parameters +  `
@group(0) @binding(1) var<storage, read> counts: array<u32>;
@group(0) @binding(2) var<storage, read> columns: array<vec4u>;
@group(0) @binding(3) var<storage, read> table: array<vec2u>;
@group(0) @binding(4) var<storage, read> raw: array<u32>;
@group(0) @binding(5) var<storage, read> totals: array<u32>;
@group(0) @binding(6) var<storage, read> reference: array<u32>;
@group(0) @binding(7) var<storage, read_write> scratch: array<atomic<u32>>;
// No reader observes a pair until this dispatch has ended. Each low-word add
// has one returned carry; high-word adds commute, including negative deltas.
fn accumulate(at: u32, value: vec2u) {
  let before = atomicAdd(&scratch[at], value.x);
  let after = before + value.x;
  atomicAdd(&scratch[at + 1u], value.y + select(0u, 1u, after < before));
}
@compute @workgroup_size(${workgroup})
fn main(@builtin(global_invocation_id) at: vec3u) {
  let cells = p.kinds * p.alphabet;
  if (at.x >= p.columns * cells || at.y >= p.nodes) { return; }
  let n = totals[at.y]; if (n < 64u) { return; }
  let c = at.x / cells; let item = at.x % cells;
  let kind = item / p.alphabet; let symbol = item % p.alphabet;
  let column = columns[p.firstColumn + c]; if (column.y == 0u) { return; }
  let cuts = column.y - 1u;
  let source = at.y * p.countNodeCells + column.x - p.countFirstCell;
  // Global price offsets may wrap u32; this difference is proved to fit the
  // current scratch segment, so modular subtraction recovers the exact offset.
  let dest = at.y * p.priceNodeWords + column.z - p.priceFirstWord;
  let totalsAt = dest + 5u * p.kinds * cuts;
  let errorAt = totalsAt + 2u * p.kinds;
  var hist = 0u; var bad = false;
  for (var b = 0u; b < column.y; b = b + 1u) {
    let v = counts[source + (kind * column.y + b) * p.alphabet + symbol];
    if (v > n || hist > n - min(v, n)) { bad = true; }
    if (!bad) { hist = hist + v; }
  }
  if (bad || hist != reference[at.y * cells + item]) {
    atomicOr(&scratch[errorAt], 1u); return;
  }
  accumulate(totalsAt + 2u * kind, vec2u(hist, 0u));
  var low = 0u;
  for (var b = 0u; b < cuts; b = b + 1u) {
    low = low + counts[source + (kind * column.y + b) * p.alphabet + symbol];
    let high = hist - low; let priceAt = dest + (kind * cuts + b) * 5u;
    accumulate(priceAt, add64(mul64(low, raw[symbol]), neg64(table[low])));
    accumulate(priceAt + 2u, add64(mul64(high, raw[symbol]), neg64(table[high])));
    atomicAdd(&scratch[priceAt + 4u], low);
  }
}
`;

const columnShader = workgroup => INT_WGSL + parameters + records +  `
@group(0) @binding(1) var<storage, read> columns: array<vec4u>;
@group(0) @binding(2) var<storage, read> table: array<vec2u>;
@group(0) @binding(3) var<storage, read> totals: array<u32>;
@group(0) @binding(4) var<storage, read_write> scratch: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> result: array<Record>;
var<workgroup> choices: array<Record, ${workgroup}>;
fn pairAt(at: u32) -> vec2u { return vec2u(atomicLoad(&scratch[at]), atomicLoad(&scratch[at + 1u])); }
@compute @workgroup_size(${workgroup})
fn main(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_id) local: vec3u) {
  if (group.x >= p.columns || group.y >= p.nodes) { return; }
  let columnId = p.firstColumn + group.x; let column = columns[columnId];
  let n = totals[group.y]; var chosen = absent();
  if (n >= 64u && column.y != 0u) {
    let cuts = column.y - 1u;
    let base = group.y * p.priceNodeWords + column.z - p.priceFirstWord;
    let totalsAt = base + 5u * p.kinds * cuts;
    var bad = atomicLoad(&scratch[totalsAt + 2u * p.kinds]) != 0u;
    for (var k = 0u; k < p.kinds; k = k + 1u) {
      let t = pairAt(totalsAt + 2u * k); if (t.x != n || t.y != 0u) { bad = true; }
    }
    if (bad) { chosen = invalid(); }
    else {
      for (var b = local.x; b < cuts; b = b + ${workgroup}u) {
        let low = atomicLoad(&scratch[base + b * 5u + 4u]);
        var previous = 0u;
        if (b != 0u) { previous = atomicLoad(&scratch[base + (b - 1u) * 5u + 4u]); }
        var consistent = low <= n && previous <= low;
        for (var k = 1u; k < p.kinds; k = k + 1u) {
          if (atomicLoad(&scratch[base + (k * cuts + b) * 5u + 4u]) != low) { consistent = false; }
        }
        if (!consistent) { chosen = invalid(); continue; }
        // The last physical bin is not a cut. An empty moved bin is ineligible.
        if (low == previous || low < 24u || n - low < 24u) { continue; }
        var candidate = Record(columnId, b, 0u, 0u, vec2u(0u), vec2u(0u));
        for (var k = 0u; k < p.kinds; k = k + 1u) {
          let at = base + (k * cuts + b) * 5u;
          let lo = add64(table[low], pairAt(at));
          let hi = add64(table[n - low], pairAt(at + 2u));
          // Each side has its own strict comparison; indices are candidate
          // positions, not predictor numbers. Candidate zero initializes it.
          if (k == 0u || less64(lo, candidate.loBits)) { candidate.loBits = lo; candidate.loSelected = k; }
          if (k == 0u || less64(hi, candidate.hiBits)) { candidate.hiBits = hi; candidate.hiSelected = k; }
        }
        chosen = winner(chosen, candidate);
      }
    }
  }
  choices[local.x] = chosen; workgroupBarrier();
  for (var stride = ${workgroup / 2}u; stride != 0u; stride = stride >> 1u) {
    if (local.x < stride) { choices[local.x] = winner(choices[local.x], choices[local.x + stride]); }
    workgroupBarrier();
  }
  if (local.x == 0u) { result[group.y * p.columns + group.x] = choices[0]; }
}
`;

const mergeShader = workgroup => INT_WGSL + parameters + records +  `
@group(0) @binding(1) var<storage, read> columns: array<Record>;
@group(0) @binding(2) var<storage, read_write> best: array<Record>;
var<workgroup> choices: array<Record, ${workgroup}>;
@compute @workgroup_size(${workgroup})
fn main(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_id) local: vec3u) {
  if (group.x >= p.nodes) { return; }
  var chosen = absent();
  for (var c = local.x; c < p.columns; c = c + ${workgroup}u) {
    chosen = winner(chosen, columns[group.x * p.columns + c]);
  }
  choices[local.x] = chosen; workgroupBarrier();
  for (var stride = ${workgroup / 2}u; stride != 0u; stride = stride >> 1u) {
    if (local.x < stride) { choices[local.x] = winner(choices[local.x], choices[local.x + stride]); }
    workgroupBarrier();
  }
  if (local.x == 0u) { best[group.x] = winner(best[group.x], choices[0]); }
}
`;

export async function createMAPricer(device, suppliedLayout, prices, {signal} = {}) {
  const started = performance.now(), made = []; let destroyed = false, activeGroup = null;
  aborted(signal);
  const {count, kinds, alphabet} = suppliedLayout ?? {};
  shape(Number.isSafeInteger(count) && count > 0 && count < 2 ** 29, 'Tree count exceeds the canonical Wasm32 table domain');
  shape(Number.isInteger(kinds) && kinds >= 1 && kinds <= 16 && Number.isInteger(alphabet) && alphabet >= 1 && alphabet <= 256,
    'Predictor/alphabet shape differs from sampledNode');
  shape(suppliedLayout.order === 'column/kind/bin/symbol' && Array.isArray(suppliedLayout.columns), 'Count layout order differs');
  shape(count * Math.max(kinds, suppliedLayout.columns.length) <= U32, 'Canonical packed sample indexing exceeds u32');
  let cells = 0, priceWords = 0, firstActive = -1, maximumColumnWords = 0;
  const columns = suppliedLayout.columns.map((column, index) => {
    shape(column.column === index && column.offset === cells && Number.isInteger(column.bins) &&
      (column.bins === 0 || (column.bins >= 2 && column.bins <= 256)), 'Column index, bins or offset differs');
    const words = column.bins ? kinds * (5 * (column.bins - 1) + 2) + 1 : 0;
    const copy = Object.freeze({column: index, offset: cells, bins: column.bins, priceOffset: priceWords, priceWords: words});
    if (column.bins && firstActive < 0) firstActive = index;
    cells += column.bins * kinds * alphabet; priceWords += words; maximumColumnWords = Math.max(maximumColumnWords, words);
    shape(Number.isSafeInteger(cells) && cells <= U32 && Number.isSafeInteger(priceWords), 'Packed cell arithmetic exceeds its exact range');
    return copy;
  });
  shape(cells === suppliedLayout.cells && suppliedLayout.bytes === cells * 4, 'Count layout size differs');
  const limits = device.limits;
  const storageBytes = Math.floor(Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize, U32) / 16) * 16;
  const groups = limits.maxComputeWorkgroupsPerDimension;
  const available = Math.min(256, limits.maxComputeInvocationsPerWorkgroup, limits.maxComputeWorkgroupSizeX,
    Math.floor(limits.maxComputeWorkgroupStorageSize / 32));
  limit(Number.isSafeInteger(storageBytes) && storageBytes >= 48 && Number.isInteger(groups) && groups >= 1 && available >= 1,
    'Device lacks usable compute, workgroup or storage limits');
  limit(limits.maxStorageBuffersPerShaderStage >= 7 && limits.maxUniformBufferBindingSize >= 48,
    'Seven storage bindings and a 48-byte uniform are required');
  let workgroup = 1; while (workgroup * 2 <= available) workgroup *= 2;
  limit(gpuSize((count + 1) * 8) <= storageBytes && gpuSize(alphabet * 4) <= storageBytes && gpuSize(columns.length * 16) <= storageBytes,
    'Canonical table/raw/column buffer exceeds an actual device binding limit');
  shape(prices?.table instanceof Float64Array && prices.table.length >= count + 1 &&
    prices.rawPrice instanceof Float64Array && prices.rawPrice.length === alphabet, 'Canonical f64 table/raw arrays are required');
  const table = prices.table.slice(0, count + 1), raw = prices.rawPrice.slice();
  const maxQ = (32 - Math.clz32(count)) * 4096 - 1;
  shape(table[0] === 0, 'The canonical entropy table must start at zero');
  let previousQ = 0;
  for (let n = 1; n <= count; n++) {
    const q = table[n] / n;
    shape(Number.isSafeInteger(table[n]) && Number.isInteger(q) && q >= previousQ && q <= maxQ,
      'Entropy table is outside the monotone exact Q12 integer domain');
    previousQ = q;
  }
  for (const value of raw) shape(Number.isSafeInteger(value) && value >= 0 && value <= 30 * 4096 && value % 4096 === 0,
    'Raw prices are outside the canonical Q12 integer domain');
  const packedTable = wordPairs(table), packedRaw = Uint32Array.from(raw);
  const meta = new Uint32Array(Math.max(4, columns.length * 4));
  for (const column of columns) {
    meta.set([column.offset, column.bins, column.priceOffset, column.priceWords], column.column * 4);
  }
  const validationAndPackMs = performance.now() - started;
  const checkPart = supplied => {
    shape(supplied && Number.isInteger(supplied.first) && Number.isInteger(supplied.columns) && supplied.first >= 0 &&
      supplied.columns > 0 && supplied.first + supplied.columns <= columns.length, 'Column part is out of range');
    const first = columns[supplied.first], last = columns[supplied.first + supplied.columns - 1];
    const expected = last.offset + last.bins * kinds * alphabet - first.offset;
    shape(supplied.base === first.offset && supplied.cells === expected, 'Column part count offsets differ');
    let largest = 0;
    for (let c = supplied.first; c < supplied.first + supplied.columns; c++) largest = Math.max(largest, columns[c].priceWords);
    return {...supplied, largest};
  };
  const groupLimit = largest => Math.min(groups, Math.floor(storageBytes / 32), Math.floor(storageBytes / (kinds * alphabet * 4)),
    Math.floor(storageBytes / gpuSize(largest * 4)));
  const maxGroupNodes = part => {
    shape(!destroyed, 'Pricer is destroyed'); return groupLimit(checkPart(part).largest);
  };
  let seed, contribute, choose, merge, tableGpu, rawGpu, metaGpu, setup;
  try {
    await gpuScoped(device, 'MA exact integer pricing setup', async () => {
      await gpuAbort(signal, async wait => {
        const at = performance.now();
        [seed, contribute, choose, merge] = await wait(Promise.all([
          gpuKernel(device, `ma-price-seed-v1-wg${workgroup}`, seedShader(workgroup), workgroup),
          gpuKernel(device, `ma-price-sums-v1-wg${workgroup}`, contributionShader(workgroup), workgroup),
          gpuKernel(device, `ma-price-columns-v1-wg${workgroup}`, columnShader(workgroup), workgroup),
          gpuKernel(device, `ma-price-merge-v1-wg${workgroup}`, mergeShader(workgroup), workgroup),
        ]));
        const pipelineMs = performance.now() - at; aborted(signal);
        const uploadAt = performance.now(), alloc = gpuAlloc(device, made);
        tableGpu = gpuUpload(device, alloc, packedTable); rawGpu = gpuUpload(device, alloc, packedRaw); metaGpu = gpuUpload(device, alloc, meta);
        await wait(gpuWait(device, device.queue.onSubmittedWorkDone())); aborted(signal);
        setup = {completeWallMs: performance.now() - started, validationAndPackMs, pipelineMs,
          uploadAndWaitMs: performance.now() - uploadAt, uploadedBytes: packedTable.byteLength + packedRaw.byteLength + meta.byteLength,
          residentLogicalBufferBytes: sumBytes(made), workgroup, storageBindingLimitBytes: storageBytes,
          maxComputeWorkgroupsPerDimension: groups, integerPriceUnit: 'Q12', histogramReadbackBytes: 0};
      });
    });
    setup.completeWallMs = performance.now() - started;
    const residentBytes = sumBytes(made);
    const layout = Object.freeze({order: 'column/kind/bin/symbol', count, kinds, alphabet, cells, bytes: cells * 4,
      columns: Object.freeze(columns.map(column => Object.freeze({column: column.column, offset: column.offset, bins: column.bins})))});
    const pricer = {
      layout, setup, residentBytes, maxGroupNodes,
      beginGroup(suppliedNodes, {signal: groupSignal} = {}) {
        aborted(groupSignal); shape(!destroyed && !activeGroup, 'Pricer is destroyed or already owns a group');
        const groupStart = performance.now(), owned = [], alloc = gpuAlloc(device, owned), ids = new Set();
        shape(Array.isArray(suppliedNodes) && suppliedNodes.length > 0, 'Pricing group must contain nodes');
        const nodes = suppliedNodes.map(node => {
          shape(typeof node?.id === 'string' && node.id.length > 0 && !ids.has(node.id), 'Node IDs must be distinct nonempty strings');
          shape(Number.isInteger(node.total) && node.total >= 0 && node.total <= count, 'Node total exceeds the tree sample count');
          ids.add(node.id); return Object.freeze({id: node.id, total: node.total});
        });
        const population = nodes.length;
        limit(population <= groupLimit(maximumColumnWords), 'Pricing group exceeds actual single-column/record/reference limits');
        const stride = Math.min(Math.ceil(priceWords / 4) * 4, Math.floor(storageBytes / (population * 16)) * 4);
        const maxColumns = Math.min(columns.length || 1, groups, Math.floor(storageBytes / (population * 32)),
          Math.floor(workgroup * groups / (kinds * alphabet)), Math.floor(U32 / (kinds * alphabet)));
        limit(maxColumns >= 1 && (firstActive < 0 || stride >= maximumColumnWords), 'One pricing column cannot fit the device limits');
        const memory = {residentLogicalBufferBytes: residentBytes, peakLogicalBufferBytes: residentBytes,
          logicalBytes: residentBytes, uploadedBytes: 0, readbackBytes: 0, proposalReadbackBytes: 0, histogramReadbackBytes: 0,
          dispatches: 0, columnParts: 0, pricingSegments: 0, nodes: population};
        const account = () => { memory.logicalBytes = residentBytes + sumBytes(owned);
          memory.peakLogicalBufferBytes = Math.max(memory.peakLogicalBufferBytes, memory.logicalBytes); };
        let totalsGpu, referenceGpu, scratchGpu, columnsGpu, bestGpu, ended = 0, seeded = false, state = 'open', encodeHostMs = 0;
        try {
          const totals = Uint32Array.from(nodes, node => node.total), initial = new Uint32Array(population * 8);
          for (let n = 0; n < population; n++) initial[n * 8] = NONE;
          totalsGpu = gpuUpload(device, alloc, totals);
          bestGpu = gpuUpload(device, alloc, initial,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
          referenceGpu = alloc(population * kinds * alphabet * 4);
          scratchGpu = alloc(population * stride * 4); columnsGpu = alloc(population * maxColumns * 32);
          memory.uploadedBytes += totals.byteLength + initial.byteLength; account();
        } catch (error) { gpuDestroy(owned); throw error; }
        const group = {
          memory,
          encodePart(encoder, {counts, part: suppliedPart}) {
            aborted(groupSignal); shape(state === 'open' && !destroyed, 'Pricing group is not open');
            const at = performance.now(), part = checkPart(suppliedPart), end = part.first + part.columns;
            shape(part.first >= ended, 'Column parts overlap or repeat');
            for (let c = ended; c < part.first; c++) shape(columns[c].bins === 0, 'An active column was skipped');
            shape(counts && Number.isSafeInteger(counts.size) && counts.size >= gpuSize(population * part.cells * 4) && counts.size <= storageBytes,
              'Resident count buffer has the wrong node-major extent');
            for (let first = part.first; first < end;) {
              let last = first, words = 0;
              while (last < end && last - first < maxColumns && words + columns[last].priceWords <= stride) {
                words += columns[last].priceWords; last++;
              }
              limit(last > first, 'One pricing column exceeds this group scratch capacity');
              const params = gpuUni(device, alloc, [population, kinds, alphabet, first, last - first, part.base, part.cells,
                columns[first].priceOffset, stride, Math.max(0, firstActive), 0, 0]);
              memory.uploadedBytes += 48;
              if (!seeded && firstActive >= first && firstActive < last) {
                gpuStep(device, encoder, seed, [params, counts, metaGpu, totalsGpu, referenceGpu], Math.ceil(kinds * alphabet / workgroup), population);
                seeded = true; memory.dispatches++;
              }
              if (words) {
                shape(seeded, 'The first active histogram column must precede pricing');
                encoder.clearBuffer(scratchGpu);
                gpuStep(device, encoder, contribute, [params, counts, metaGpu, tableGpu, rawGpu, totalsGpu, referenceGpu, scratchGpu],
                  Math.ceil((last - first) * kinds * alphabet / workgroup), population);
                gpuStep(device, encoder, choose, [params, metaGpu, tableGpu, totalsGpu, scratchGpu, columnsGpu], last - first, population);
                gpuStep(device, encoder, merge, [params, columnsGpu, bestGpu], population, 1);
                memory.dispatches += 3;
              }
              memory.pricingSegments++; first = last;
            }
            ended = end; memory.columnParts++; account(); encodeHostMs += performance.now() - at;
          },
          async finish({signal: finishSignal = groupSignal} = {}) {
            aborted(groupSignal); aborted(finishSignal); shape(state === 'open' && !destroyed, 'Pricing group is not open');
            for (let c = ended; c < columns.length; c++) shape(columns[c].bins === 0, 'Pricing ended before all active columns');
            const finishAt = performance.now(); state = 'finishing';
            try {
              const bytes = population * 32, encoder = device.createCommandEncoder();
              const [map, take] = gpuStage(device, alloc, encoder, [[bestGpu, 0, bytes]], 'ma-price-records');
              account(); device.queue.submit([encoder.finish()]);
              const buffers = await gpuAbort(groupSignal, groupWait => gpuAbort(finishSignal, async finishWait => {
                await groupWait(finishWait(map()));
                const result = take(); await groupWait(finishWait(gpuWait(device, device.queue.onSubmittedWorkDone()))); return result;
              }));
              aborted(groupSignal); aborted(finishSignal); shape(state === 'finishing', 'Pricing group was destroyed during readback');
              memory.readbackBytes = bytes; memory.proposalReadbackBytes = bytes;
              const unpackAt = performance.now(), words = new Uint32Array(buffers[0]);
              const results = nodes.map((node, n) => {
                const at = n * 8, column = words[at];
                if (column === BAD) throw Object.assign(new Error(`Inconsistent resident histograms for node ${node.id}`), {code: 'MA_PRICE_COUNTS'});
                if (column === NONE) return {...node, record: null};
                const bin = words[at + 1], loSelected = words[at + 2], hiSelected = words[at + 3];
                const loBits = words[at + 4] + words[at + 5] * TWO32, hiBits = words[at + 6] + words[at + 7] * TWO32;
                shape(column < columns.length && bin < columns[column].bins - 1 && loSelected < kinds && hiSelected < kinds &&
                  Number.isSafeInteger(loBits) && Number.isSafeInteger(hiBits), 'GPU proposal record is outside the exact canonical ABI');
                return {...node, record: {column, bin, loSelected, hiSelected, loBits, hiBits}};
              });
              state = 'finished';
              return {results, memory: {...memory}, timing: {completeWallMs: performance.now() - groupStart,
                encodeHostMs, finishWallMs: performance.now() - finishAt, unpackWallMs: performance.now() - unpackAt,
                scope: 'group lifetime includes caller count scheduling; finish waits for all preceding count/price commands and small-record readback'}};
            } catch (error) { group.destroy(); throw error; }
          },
          destroy() {
            if (state === 'destroyed') return;
            state = 'destroyed'; gpuDestroy(owned); memory.logicalBytes = destroyed ? 0 : residentBytes;
            if (activeGroup === group) activeGroup = null;
          },
        };
        activeGroup = group; return group;
      },
      destroy() { if (destroyed) return; destroyed = true; activeGroup?.destroy(); gpuDestroy(made); },
    };
    return pricer;
  } catch (error) { gpuDestroy(made); throw error; }
}
