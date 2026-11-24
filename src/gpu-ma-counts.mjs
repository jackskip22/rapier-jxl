// SPDX-License-Identifier: MIT
import {INT_WGSL} from './int-ops.mjs';
import {gpuWait, gpuCheck, gpuKernel, gpuAlloc, gpuUpload, gpuUni, gpuStep, gpuStage, gpuDestroy, gpuScoped, gpuSize} from './gpu-kit.mjs';

const MAX_U32 = 0xffffffff;
const requireShape = (ok, reason) => { if (!ok) throw Object.assign(new Error(reason), {code: 'MA_BATCH_SHAPE'}); };
const requireLimit = (ok, reason) => { if (!ok) throw Object.assign(new Error(reason), {code: 'MA_BATCH_LIMIT'}); };
const aborted = signal => { if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError'); };
const round4 = n => Math.ceil(n / 4) * 4;

const shader = workgroup => INT_WGSL +  `
struct Params {
  total: u32, count: u32, kinds: u32, alphabet: u32,
  firstColumn: u32, columns: u32, firstCell: u32, nodeCells: u32,
}
@group(0) @binding(0) var<uniform> p: Params;
// One pair per actual member occurrence: sample ID and this output batch's node ID.
@group(0) @binding(1) var<storage, read> members: array<vec2u>;
@group(0) @binding(2) var<storage, read> symbols: array<u32>;
@group(0) @binding(3) var<storage, read> indices: array<u32>;
@group(0) @binding(4) var<storage, read> columns: array<vec2u>;
@group(0) @binding(5) var<storage, read_write> counts: array<atomic<u32>>;
@compute @workgroup_size(${workgroup})
fn main(@builtin(global_invocation_id) at: vec3u) {
  if (at.x >= p.total || at.y >= p.columns) { return; }
  let columnId = p.firstColumn + at.y;
  let column = columns[columnId];
  if (column.y == 0u) { return; }
  let entry = members[at.x];
  let idx = columnId * p.count + entry.x;
  let bin = (indices[idx >> 2u] >> ((idx & 3u) * 8u)) & 255u;
  for (var kind = 0u; kind < p.kinds; kind = kind + 1u) {
    let pos = kind * p.count + entry.x;
    let symbol = (symbols[pos >> 2u] >> ((pos & 3u) * 8u)) & 255u;
    let cell = entry.y * p.nodeCells + column.x - p.firstCell
      + (kind * column.y + bin) * p.alphabet + symbol;
    atomicAdd(&counts[cell], 1u);
  }
}
`;

export function maHistogramLayout({count, kinds, alphabet, columns, symbolSets}) {
  requireShape(Number.isSafeInteger(count) && count > 0 && count <= MAX_U32, 'count must fit a nonzero u32');
  requireShape(Number.isInteger(kinds) && kinds >= 1 && kinds <= 16, 'kinds must be 1..16');
  requireShape(Number.isInteger(alphabet) && alphabet >= 1 && alphabet <= 256, 'alphabet must be 1..256');
  requireShape(Array.isArray(columns) && Array.isArray(symbolSets) && symbolSets.length === kinds, 'Invalid columns or predictor arrays');
  requireShape(columns.length <= MAX_U32 && count * Math.max(kinds, columns.length) <= MAX_U32, 'Packed byte indexing exceeds u32');
  const layout = []; let cells = 0;
  for (let c = 0; c < columns.length; c++) {
    const column = columns[c], cuts = column.cuts?.length;
    requireShape(Number.isInteger(cuts) && cuts >= 0 && cuts <= 255, 'A column must have 0..255 cuts');
    requireShape(column.indices instanceof Uint8Array && column.indices.length === count, 'A column lacks exact u8 sample bins');
    const bins = cuts ? cuts + 1 : 0;
    layout.push(Object.freeze({column: c, property: column.property ?? null, offset: cells, bins}));
    cells += bins * kinds * alphabet;
    requireShape(Number.isSafeInteger(cells) && cells <= MAX_U32, 'Count layout exceeds u32 indexing');
    for (const value of column.indices) requireShape(value <= cuts, 'Column bin exceeds its cut count');
  }
  for (const symbols of symbolSets) {
    requireShape(symbols instanceof Uint8Array && symbols.length === count, 'A predictor lacks exact u8 symbols');
    for (const symbol of symbols) requireShape(symbol < alphabet, 'Predictor symbol exceeds alphabet');
  }
  return Object.freeze({order: 'column/kind/bin/symbol', cells, bytes: cells * 4,
    count, kinds, alphabet, columns: Object.freeze(layout)});
}

export async function createMAHistogramBatch(device, samples, {signal} = {}) {
  const started = performance.now(), made = []; let busy = false, destroyed = false;
  aborted(signal);
  const layout = maHistogramLayout(samples), {count, kinds, alphabet} = layout;
  const limits = device.limits;
  const storageBytes = Math.floor(Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize, MAX_U32) / 16) * 16;
  const groups = limits.maxComputeWorkgroupsPerDimension;
  let workgroup = 1;
  const available = Math.min(256, limits.maxComputeInvocationsPerWorkgroup, limits.maxComputeWorkgroupSizeX);
  while (workgroup * 2 <= available) workgroup *= 2;
  requireLimit(Number.isFinite(storageBytes) && storageBytes >= 16 && Number.isInteger(groups) && groups >= 1 && available >= 1,
    'Device does not expose usable compute/storage limits');
  requireLimit(limits.maxStorageBuffersPerShaderStage >= 5, 'Five storage bindings are required');
  requireLimit(gpuSize(kinds * count) <= storageBytes && gpuSize(samples.columns.length * count) <= storageBytes &&
    gpuSize(samples.columns.length * 8) <= storageBytes, 'Immutable symbol/bin/column buffer exceeds this device binding limit');
  const parts = [];
  for (let first = 0; first < layout.columns.length;) {
    let last = first, cells = 0;
    while (last < layout.columns.length && last - first < groups) {
      const add = layout.columns[last].bins * kinds * alphabet;
      if (gpuSize((cells + add) * 4) > storageBytes) break;
      cells += add; last++;
    }
    requireLimit(last > first, 'One column exceeds this device count-buffer limit');
    parts.push({first, columns: last - first, base: layout.columns[first].offset, cells});
    first = last;
  }
  const maxWaveMembers = Math.min(Math.floor(storageBytes / 8), workgroup * groups, MAX_U32);
  requireLimit(maxWaveMembers >= 1, 'No member upload/dispatch fits device limits');
  try {
    const packedAt = performance.now();
    const symbols = new Uint8Array(round4(kinds * count)), indices = new Uint8Array(round4(samples.columns.length * count));
    const meta = new Uint32Array(Math.max(2, samples.columns.length * 2));
    for (let k = 0; k < kinds; k++) symbols.set(samples.symbolSets[k], k * count);
    for (let c = 0; c < samples.columns.length; c++) {
      indices.set(samples.columns[c].indices, c * count);
      meta[c * 2] = layout.columns[c].offset; meta[c * 2 + 1] = layout.columns[c].bins;
    }
    const packedMs = performance.now() - packedAt;
    let kernel, symbolGpu, indexGpu, metaGpu, pipelineMs, uploadMs;
    await gpuScoped(device, 'MA resident samples', async () => {
      aborted(signal);
      let at = performance.now();
      try { kernel = await gpuKernel(device, `ma-batch-u32-v1-wg${workgroup}`, shader(workgroup), workgroup); }
      catch (error) {
        gpuCheck(device);
        const info = await gpuWait(device, device.createShaderModule({code: shader(workgroup)}).getCompilationInfo());
        throw new Error([String(error), ...info.messages.map(m => `${m.type} ${m.lineNum}:${m.linePos}: ${m.message}`)].join('\n'), {cause: error});
      }
      pipelineMs = performance.now() - at; aborted(signal); at = performance.now();
      const alloc = gpuAlloc(device, made);
      symbolGpu = gpuUpload(device, alloc, symbols); indexGpu = gpuUpload(device, alloc, indices); metaGpu = gpuUpload(device, alloc, meta);
      await gpuWait(device, device.queue.onSubmittedWorkDone());
      uploadMs = performance.now() - at; aborted(signal);
    });
    const residentBytes = made.reduce((n, b) => n + b.size, 0);
    const setup = {completeWallMs: performance.now() - started, validationAndPackMs: performance.now() - started - pipelineMs - uploadMs,
      packMs: packedMs, pipelineMs, uploadAndWaitMs: uploadMs, uploadedBytes: symbols.byteLength + indices.byteLength + meta.byteLength,
      residentLogicalBufferBytes: residentBytes, workgroup, storageBindingLimitBytes: storageBytes,
      maxComputeWorkgroupsPerDimension: groups, maxWaveMembers, columnParts: parts.length};
    const session = {
      layout, setup,
      async histograms(nodes, {signal: runSignal} = {}) {
        requireShape(!destroyed && !busy, 'Session is destroyed or already running a batch');
        busy = true; const batchStart = performance.now();
        const stats = {dispatches: 0, memberWaves: 0, outputChunks: 0, memberUploadBytes: 0, readbackBytes: 0,
          residentLogicalBufferBytes: residentBytes, peakLogicalBufferBytes: residentBytes, immutableUploadsInBatch: 0};
        try {
          aborted(runSignal); requireShape(Array.isArray(nodes), 'Nodes must be an array');
          const ids = new Set();
          nodes = nodes.map(node => {
            requireShape(typeof node?.id === 'string' && node.id.length > 0 && !ids.has(node.id), 'Node IDs must be distinct nonempty strings');
            ids.add(node.id);
            requireShape(node.members instanceof Uint32Array && node.members.length <= count, 'Node members must be u32 IDs within the canonical sample population');
            const members = node.members.slice();
            for (const member of members) requireShape(member < count, `Out-of-range member in node ${node.id}`);
            return {id: node.id, members};
          });
          const validatedMs = performance.now() - batchStart;
          const results = nodes.map(node => ({id: node.id, members: node.members.length, counts: new Uint32Array(layout.cells)}));
          await gpuScoped(device, 'MA histogram batch', async () => {
            for (const part of parts) {
              if (!part.cells) continue;
              const maxNodes = Math.floor(storageBytes / (part.cells * 4));
              for (let firstNode = 0; firstNode < nodes.length; firstNode += maxNodes) {
                aborted(runSignal);
                const group = nodes.slice(firstNode, firstNode + maxNodes), transient = [], alloc = gpuAlloc(device, transient);
                try {
                  const outputBytes = group.length * part.cells * 4, output = alloc(outputBytes);
                  let encoder = device.createCommandEncoder(); encoder.clearBuffer(output);
                  const totalMembers = group.reduce((sum, node) => sum + node.members.length, 0);
                  const waveCapacity = Math.min(maxWaveMembers, Math.max(1, totalMembers));
                  const pairs = new Uint32Array(waveCapacity * 2), membersGpu = alloc(pairs.byteLength);
                  const parameters = gpuUni(device, alloc, [0, count, kinds, alphabet, part.first, part.columns, part.base, part.cells]);
                  let nodeAt = 0, memberAt = 0;
                  while (nodeAt < group.length) {
                    let used = 0;
                    while (used < waveCapacity && nodeAt < group.length) {
                      const node = group[nodeAt];
                      while (memberAt < node.members.length && used < waveCapacity) {
                        pairs[used * 2] = node.members[memberAt++]; pairs[used * 2 + 1] = nodeAt; used++;
                      }
                      if (memberAt === node.members.length) { nodeAt++; memberAt = 0; }
                    }
                    if (!used) break;
                    device.queue.writeBuffer(membersGpu, 0, pairs.buffer, 0, used * 8);
                    device.queue.writeBuffer(parameters, 0, new Uint32Array([used, count, kinds, alphabet, part.first, part.columns, part.base, part.cells]));
                    gpuStep(device, encoder, kernel, [parameters, membersGpu, symbolGpu, indexGpu, metaGpu, output], Math.ceil(used / workgroup), part.columns);
                    device.queue.submit([encoder.finish()]); encoder = device.createCommandEncoder();
                    stats.dispatches++; stats.memberWaves++; stats.memberUploadBytes += used * 8;
                    aborted(runSignal);
                  }
                  const [map, take] = gpuStage(device, alloc, encoder, [[output, 0, outputBytes]]);
                  stats.peakLogicalBufferBytes = Math.max(stats.peakLogicalBufferBytes, residentBytes + transient.reduce((sum, b) => sum + b.size, 0));
                  device.queue.submit([encoder.finish()]); await map();
                  const counts = new Uint32Array(take()[0]); aborted(runSignal);
                  for (let n = 0; n < group.length; n++) results[firstNode + n].counts.set(counts.subarray(n * part.cells, (n + 1) * part.cells), part.base);
                  stats.outputChunks++; stats.readbackBytes += outputBytes;
                } finally { gpuDestroy(transient); }
              }
            }
          });
          aborted(runSignal);
          return {results, layout, timing: {completeWallMs: performance.now() - batchStart, validationMs: validatedMs}, memory: stats};
        } finally { busy = false; }
      },
      async proposals(nodes, pricer, {signal: runSignal} = {}) {
        requireShape(!destroyed && !busy, 'Session is destroyed or already running a batch');
        requireShape(pricer && typeof pricer.beginGroup === 'function' && typeof pricer.maxGroupNodes === 'function',
          'An exact device pricing stage is required');
        const pricedLayout = pricer.layout;
        requireShape(pricedLayout && ['order', 'count', 'kinds', 'alphabet', 'cells', 'bytes'].every(key => pricedLayout[key] === layout[key]) &&
          pricedLayout.columns?.length === layout.columns.length && layout.columns.every((column, index) =>
            ['column', 'offset', 'bins'].every(key => pricedLayout.columns[index]?.[key] === column[key])),
          'Pricing and count layouts must be identical');
        const priceResidentBytes = pricer.residentBytes;
        requireShape(Number.isSafeInteger(priceResidentBytes) && priceResidentBytes >= 0, 'Pricing residency accounting differs');
        busy = true; const batchStart = performance.now();
        const stats = {dispatches: 0, memberWaves: 0, outputChunks: 0, columnParts: 0,
          memberUploadBytes: 0, readbackBytes: 0, histogramReadbackBytes: 0,
          residentLogicalBufferBytes: residentBytes + priceResidentBytes,
          peakLogicalBufferBytes: residentBytes + priceResidentBytes, immutableUploadsInBatch: 0, pricingGroups: []};
        try {
          aborted(runSignal); requireShape(Array.isArray(nodes), 'Nodes must be an array');
          const ids = new Set();
          nodes = nodes.map(node => {
            requireShape(typeof node?.id === 'string' && node.id.length > 0 && !ids.has(node.id), 'Node IDs must be distinct nonempty strings');
            ids.add(node.id);
            requireShape(node.members instanceof Uint32Array && node.members.length <= count,
              'Node members must be u32 IDs within the canonical sample population');
            const members = node.members.slice();
            for (const member of members) requireShape(member < count, `Out-of-range member in node ${node.id}`);
            return {id: node.id, members};
          });
          const validatedMs = performance.now() - batchStart;
          const results = nodes.map(node => ({id: node.id, total: node.members.length, record: null}));
          const active = parts.filter(part => part.cells > 0);
          if (!active.length || !nodes.length)
            return {results, layout, timing: {completeWallMs: performance.now() - batchStart, validationMs: validatedMs}, memory: stats};
          const maxPartCells = active.reduce((maximum, part) => Math.max(maximum, part.cells), 0);
          let maxNodes = Math.floor(storageBytes / (maxPartCells * 4));
          for (const part of active) {
            const limit = pricer.maxGroupNodes(part);
            requireLimit(Number.isSafeInteger(limit) && limit >= 1, 'One node exceeds actual device pricing limits');
            maxNodes = Math.min(maxNodes, limit);
          }
          requireLimit(maxNodes >= 1, 'No node fits the device count/pricing buffers');
          await gpuScoped(device, 'MA resident count and integer pricing', async () => {
            for (let firstNode = 0; firstNode < nodes.length; firstNode += maxNodes) {
              aborted(runSignal);
              const group = nodes.slice(firstNode, firstNode + maxNodes), transient = [], alloc = gpuAlloc(device, transient);
              let priceGroup;
              try {
                const output = alloc(group.length * maxPartCells * 4);
                const totalMembers = group.reduce((sum, node) => sum + node.members.length, 0);
                requireShape(Number.isSafeInteger(totalMembers), 'Combined member population is not exactly indexable');
                const waveCapacity = Math.min(maxWaveMembers, Math.max(1, totalMembers));
                const pairs = new Uint32Array(waveCapacity * 2), membersGpu = alloc(pairs.byteLength);
                const parameters = gpuUni(device, alloc, new Uint32Array(8));
                priceGroup = await pricer.beginGroup(group.map(node => ({id: node.id, total: node.members.length})), {signal: runSignal});
                for (const part of active) {
                  aborted(runSignal);
                  let encoder = device.createCommandEncoder(); encoder.clearBuffer(output);
                  let nodeAt = 0, memberAt = 0;
                  while (nodeAt < group.length) {
                    let used = 0;
                    while (used < waveCapacity && nodeAt < group.length) {
                      const node = group[nodeAt];
                      while (memberAt < node.members.length && used < waveCapacity) {
                        pairs[used * 2] = node.members[memberAt++]; pairs[used * 2 + 1] = nodeAt; used++;
                      }
                      if (memberAt === node.members.length) { nodeAt++; memberAt = 0; }
                    }
                    if (!used) break;
                    device.queue.writeBuffer(membersGpu, 0, pairs.buffer, 0, used * 8);
                    device.queue.writeBuffer(parameters, 0, new Uint32Array([used, count, kinds, alphabet,
                      part.first, part.columns, part.base, part.cells]));
                    gpuStep(device, encoder, kernel, [parameters, membersGpu, symbolGpu, indexGpu, metaGpu, output],
                      Math.ceil(used / workgroup), part.columns);
                    device.queue.submit([encoder.finish()]); encoder = device.createCommandEncoder();
                    stats.dispatches++; stats.memberWaves++; stats.memberUploadBytes += used * 8;
                    aborted(runSignal);
                  }
                  priceGroup.encodePart(encoder, {counts: output, part});
                  device.queue.submit([encoder.finish()]);
                  stats.columnParts++;
                }
                const priced = await priceGroup.finish({signal: runSignal}); aborted(runSignal);
                requireShape(Array.isArray(priced.results) && priced.results.length === group.length, 'Pricing record population differs');
                for (let n = 0; n < group.length; n++) {
                  requireShape(priced.results[n].id === group[n].id && priced.results[n].total === group[n].members.length,
                    'Pricing record node identity differs');
                  results[firstNode + n] = priced.results[n];
                }
                const rootBytes = transient.reduce((sum, buffer) => sum + buffer.size, 0);
                const pricePeak = priced.memory?.peakLogicalBufferBytes;
                requireShape(Number.isSafeInteger(pricePeak) && pricePeak >= 0 &&
                  Number.isSafeInteger(priced.memory?.readbackBytes) && priced.memory.readbackBytes >= 0,
                  'Pricing transfer/allocation accounting differs');
                stats.peakLogicalBufferBytes = Math.max(stats.peakLogicalBufferBytes,
                  residentBytes + rootBytes + pricePeak);
                stats.readbackBytes += priced.memory.readbackBytes;
                stats.pricingGroups.push({firstNode, nodes: group.length, timing: priced.timing, memory: priced.memory});
                stats.outputChunks++;
              } finally { priceGroup?.destroy(); gpuDestroy(transient); }
            }
          });
          aborted(runSignal);
          return {results, layout, timing: {completeWallMs: performance.now() - batchStart, validationMs: validatedMs}, memory: stats};
        } finally { busy = false; }
      },
      destroy() { destroyed = true; gpuDestroy(made); },
    };
    return session;
  } catch (error) { gpuDestroy(made); throw error; }
}
