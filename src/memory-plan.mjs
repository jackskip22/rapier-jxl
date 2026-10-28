// SPDX-License-Identifier: MIT
export const MEMORY_BUDGET = 1_073_741_824;
export const WORKER_SCRATCH_BYTES = 3 * 32 * 32 * 64 * 7 + 3 * 32 * 32 * 4;
const MEMORY_BAND_ROWS = [128, 64, 32, 16, 8], MEMORY_RECON_MARGIN = 8, UNKNOWN_WHOLE_PIXELS = 524288;
const BUTTERAUGLI_RING_BYTES = 22992;
const RECON_SCRATCH = 2 * 256 * 256 * 8;

function reconstructionBytes(width, padded, blocks) {
  return memorySum(Math.max(mul(20, padded), memorySum(mul(12, padded), mul(45, width))), mul(8, blocks), RECON_SCRATCH);
}

function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`${name} must be a safe integer >= ${minimum}`);
  return value;
}
function memorySum(...values) {
  return integer(values.reduce((a, b) => a + b, 0), 'memory byte total');
}
function mul(a, b) { return integer(a * b, 'memory byte product'); }

export function memoryGeometry(pixels, {width, height} = {}) {
  integer(pixels, 'pixels');
  if (width !== undefined) integer(width, 'width', 1);
  if (height !== undefined) integer(height, 'height', 1);
  if (width === undefined || pixels === 0) return null;
  height ??= pixels / width;
  integer(height, 'height', 1);
  if (mul(width, height) !== pixels) throw new RangeError('width * height must equal pixels');
  const stride = Math.ceil(width / 8), rows = Math.ceil(height / 8), blocks = mul(stride, rows);
  return {width, height, pixels, stride, rows, blocks, padded: mul(blocks, 64),
    tiles: mul(Math.ceil(stride / 8), Math.ceil(rows / 8))};
}

function memoryHalfGeometry(w, h) {
  const width = Math.ceil(w / 2), height = Math.ceil(h / 2);
  return {width, height, pixels: mul(width, height), active: width >= 8 && height >= 8};
}

export function butteraugliBytes(width, height) {
  integer(width, 'width', 1); integer(height, 'height', 1);
  const n = mul(width, height), sub = memoryHalfGeometry(width, height), d = sub.active ? sub.pixels : 0;
  const reference = mul(80, memorySum(n, d));
  const work = memorySum(Math.max(mul(160, n), memorySum(mul(8, n), mul(184, d))), mul(8, width));
  return {reference, work};
}

export function bandBytes(width, height, rows = 8, {map = false} = {}) {
  integer(width, 'width', 1); integer(height, 'height', 1); integer(rows, 'band rows', 1);
  if (rows % 8) throw new RangeError('band rows must be a multiple of 8');
  const n = mul(width, height), bandHeight = Math.min(height, rows), paddedWidth = 8 * Math.ceil(width / 8);
  const subHeight = Math.min(8 * Math.ceil(height / 8), 64 * Math.ceil((bandHeight + 2 * MEMORY_RECON_MARGIN + 63) / 64));
  const sub = mul(paddedWidth, subHeight), blocks = mul(Math.ceil(width / 8), Math.ceil(height / 8));
  const image = memorySum(mul(16, sub), mul(34, sub / 64), 3 * 64 * 4);
  const reconstruction = reconstructionBytes(paddedWidth, sub, sub / 64);
  const score = memorySum(mul(12, sub), mul(BUTTERAUGLI_RING_BYTES, width), mul(16, width));
  const result = map ? mul(8, n) : mul(16, blocks);
  return {rows, padded: sub, result, imageBytes: image, work: memorySum(image, Math.max(reconstruction, score), result)};
}

export function ssimulacra2Bytes(width, height, {native = false, map = false} = {}) {
  integer(width, 'width', 1); integer(height, 'height', 1);
  if (native && map) throw new Error('native SSIMULACRA2 has no map');
  const n = mul(width, height), candidate = mul(native ? 4 : 12, n), scales = [];
  let w = width, h = height;
  for (let s = 0; s < 6; s++) {
    if (w < 8 || h < 8) break;
    if (s) { w = Math.ceil(w / 2); h = Math.ceil(h / 2); }
    scales.push({width: w, height: h, pixels: mul(w, h)});
  }
  let peak = 0, local = 0;
  for (let i = 0; i < scales.length; i++) {
    const cur = scales[i], next = scales[i + 1];
    const source = i ? mul(48, cur.pixels) : 0;
    local = map ? memorySum(local, mul(72, cur.pixels)) : 0;
    const active = map ? memorySum(mul(8, n), local, mul(56, cur.pixels)) : mul(native ? 612 : 896, cur.width);
    peak = Math.max(peak, memorySum(candidate, source, active));
    if (next) peak = Math.max(peak, memorySum(candidate, source, mul(48, next.pixels), map ? memorySum(mul(8, n), local) : 0));
    if (map) peak = Math.max(peak, memorySum(candidate, mul(8, n), local, mul(8, cur.pixels)));
  }
  return {work: peak, candidate, scales};
}

const REQUIRED = ['externalBytes', 'searchBytes', 'entropyBytes', 'outputBytes', 'gpuBytes'];
export function memoryPlan(pixels, options = {}) {
  const budgetBytes = integer(options.budgetBytes ?? MEMORY_BUDGET, 'budgetBytes');
  const g = memoryGeometry(pixels, options), unknown = [];
  const reserve = {};
  for (const name of REQUIRED) {
    if (options[name] === undefined) { unknown.push(name); reserve[name] = 0; }
    else reserve[name] = integer(options[name], name);
  }
  if (!g) unknown.unshift('dimensions');
  const exact = options.exact ?? true, map = options.map ?? false;
  if (!exact && map) throw new Error('native SSIMULACRA2 has no map');
  const cores = integer(options.cores ?? 2, 'cores', 1);
  const requestedWorkers = integer(options.workers ?? 0, 'workers');
  const requestedCache = integer(options.cacheBytes ?? 0, 'cacheBytes');
  const workerKnown = ['workerRuntimeBytes', 'workerJobBytes', 'workerInputBytes', 'workerOutputBytes'].every(name => options[name] !== undefined);
  const workerRuntime = integer(options.workerRuntimeBytes ?? 0, 'workerRuntimeBytes');
  const workerJob = integer(options.workerJobBytes ?? 0, 'workerJobBytes');
  const workerInput = integer(options.workerInputBytes ?? 0, 'workerInputBytes');
  const workerOutput = integer(options.workerOutputBytes ?? 0, 'workerOutputBytes');
  const workerReady = workerKnown && workerRuntime > 0 && workerInput > 0 && workerOutput > 0;
  if (requestedWorkers > 0 && workerReady && memorySum(workerInput, mul(2, workerOutput), WORKER_SCRATCH_BYTES) > workerJob)
    throw new RangeError('workerJobBytes must include input, two output buffers and the helper ANS scratch');
  const known = unknown.length === 0;
  if (!g) return {known: false, fits: false, used: 0, budgetBytes, unknown, dct: false, workers: 0,
    poolBytes: 0, cacheBytes: 0, banded: options.banded !== false, bandRows: 8, stages: {}, reservations: reserve,
    workerReservation: Object.freeze({count: 0, runtimeBytes: 0, jobBytes: 0, inputBytes: 0, outputBytes: 0,
      scratchBytes: WORKER_SCRATCH_BYTES, totalBytes: 0})};
  const {width, height, padded, blocks, tiles} = g;
  const input = integer(options.inputBytes ?? mul(4, pixels), 'inputBytes');
  if (input < mul(4, pixels)) throw new RangeError('inputBytes does not cover the RGBA input');
  const metricInput = integer(options.metricInputBytes ?? mul(4, pixels), 'metricInputBytes');
  const extraReference = integer(options.referenceBytes ?? 0, 'referenceBytes');
  const ambient = memorySum(reserve.externalBytes, reserve.gpuBytes);
  const pre = mul(24, padded), dctBytes = memorySum(mul(48, padded), mul(4, tiles));
  const prepared = memorySum(ambient, input, pre, metricInput, extraReference, reserve.searchBytes, reserve.outputBytes);
  const reconstruction = reconstructionBytes(width, padded, blocks);
  const metric = ssimulacra2Bytes(width, height, {native: !exact, map});
  const ba = butteraugliBytes(width, height);
  function stagesFor(banded, rows, dct = false, workers = 0, cacheBytes = 0) {
    const retained = memorySum(prepared, dct ? dctBytes : 0, cacheBytes, mul(workers, workerRuntime), banded ? 0 : ba.reference);
    const stages = {
      prepare: memorySum(ambient, input, metricInput, extraReference, mul(56, padded), mul(8, blocks)),
      reconstruct: memorySum(retained, reconstruction),
      ssimulacra2: memorySum(retained, metric.work),
      butteraugli: banded ? memorySum(retained, bandBytes(width, height, rows, {map}).work)
        : memorySum(retained, mul(24, pixels), mul(12, pixels), ba.work, mul(16, blocks)),
      entropy: memorySum(retained, reserve.entropyBytes),
    };
    if (workers) {
      stages.regions = memorySum(retained, mul(workers, workerJob));
      stages.acWorkers = memorySum(retained, reserve.entropyBytes, mul(workers, workerJob));
    }
    return stages;
  }
  const maximum = stages => Math.max(...Object.values(stages));
  let banded = options.banded !== false, bandRows = 8;
  if (known && options.banded !== true && maximum(stagesFor(false, 8)) <= budgetBytes) banded = false;
  else if (known && banded) for (const rows of MEMORY_BAND_ROWS) {
    if (maximum(stagesFor(true, rows)) <= budgetBytes) { bandRows = rows; break; }
  }
  else if (banded && width * height <= UNKNOWN_WHOLE_PIXELS && options.banded !== true) banded = false;
  else if (banded) bandRows = MEMORY_BAND_ROWS[0];
  if (options.bandRows !== undefined) {
    integer(options.bandRows, 'bandRows', 8);
    if (!MEMORY_BAND_ROWS.includes(options.bandRows)) throw new RangeError('bandRows must be 8, 16, 32, 64 or 128');
    if (known) bandRows = options.bandRows;
  }
  let stages = stagesFor(banded, bandRows), used = maximum(stages), dct = false, workers = 0, cacheBytes = 0;
  if (known && used <= budgetBytes) {
    if (options.dct !== false && maximum(stagesFor(banded, bandRows, true)) <= budgetBytes) dct = true;
    if (workerReady) {
      const baseStages = stagesFor(banded, bandRows, dct);
      const resting = memorySum(prepared, dct ? dctBytes : 0, banded ? 0 : ba.reference);
      const runtimeCap = workerRuntime ? Math.floor((budgetBytes - maximum(baseStages)) / workerRuntime) : Number.MAX_SAFE_INTEGER;
      const jobCap = Math.floor((budgetBytes - resting - reserve.entropyBytes) / memorySum(workerRuntime, workerJob));
      workers = Math.max(0, Math.min(requestedWorkers, cores - 1, runtimeCap, jobCap));
    }
    stages = stagesFor(banded, bandRows, dct, workers);
    cacheBytes = Math.min(requestedCache, Math.max(0, budgetBytes - maximum(stages)));
    stages = stagesFor(banded, bandRows, dct, workers, cacheBytes); used = maximum(stages);
  }
  return Object.freeze({known, fits: known && used <= budgetBytes, used, budgetBytes, unknown: Object.freeze(unknown),
    dct, dctBytes: dct ? dctBytes : 0, workers, poolBytes: mul(workers, memorySum(workerRuntime, workerJob)),
    workerRuntimeBytes: workerRuntime, workerJobBytes: workerJob, cacheBytes, banded, bandRows,
    workerCropPixels: 224 * 224, workerBlockPixels: 320 * 320,
    workerReservation: Object.freeze({count: workers, runtimeBytes: workerRuntime, jobBytes: workerJob,
      inputBytes: workerInput, outputBytes: workerOutput, scratchBytes: WORKER_SCRATCH_BYTES,
      totalBytes: mul(workers, memorySum(workerRuntime, workerJob))}),
    stages: Object.freeze(stages), geometry: Object.freeze(g), reservations: Object.freeze({...reserve,
      inputBytes: input, metricInputBytes: metricInput, referenceBytes: extraReference}),
    scope: 'conditional live-allocation reservation; process/GPU peak requires independent measurement'});
}

export function bandsExact(pixels, options = {}) { return memoryPlan(pixels, options).banded; }
export function predictedBytes(pixels, options = {}) { return memoryPlan(pixels, options).used; }
export function keepsDct(pixels, _plain = true, width, options = {}) { return memoryPlan(pixels, {...options, width}).dct; }
export function poolWorkers(pixels, cores, options = {}) { return memoryPlan(pixels, {...options, cores: cores ?? 2}).workers; }
