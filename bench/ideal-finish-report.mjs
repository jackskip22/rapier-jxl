#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Recalculate the finish report from retained observations, never from prose or rounded table cells.
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {createHash} from 'node:crypto';

const [command, directory, verification] = process.argv.slice(2);
assert.equal(command, '--summary', 'Use ideal-finish-report.mjs --summary RECEIPT_DIRECTORY');
assert(directory);
assert(verification == null || verification === '--check');
const root = resolve(directory), read = name => JSON.parse(readFileSync(join(root, name), 'utf8'));
const lines = name => readFileSync(join(root, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const median = values => { const a = [...values].sort((a, b) => a - b), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const range = a => a.length ? {count: a.length, median: median(a), minimum: Math.min(...a), maximum: Math.max(...a)} : {count: 0};
const tolerance = (metric, value) => metric === 'ssimulacra2' ? .25 : Math.max(.02, value * .02);
const hash = file => createHash('sha256').update(readFileSync(join(root, file))).digest('hex');
const index = read('index.json'), summary = {protocol: 1, inputs: {}, limitations: index.limitations ?? []};
for (const file of index.files ?? []) { assert(existsSync(join(root, file)), 'Missing receipt ' + file); summary.inputs[file] = hash(file); }

function validateDecode(row) {
  for (const name of ['djxl', 'oxide']) {
    assert(row.decodes[name].decoded, 'Independent decode missing');
    assert.equal(row.decodes[name].alphaChangedSamples, 0, 'Alpha changed');
    if (row.mode === 'lossless' || row.quality === 100) assert.equal(row.decodes[name].changedSamples, 0, 'Lossless samples changed');
  }
  assert(row.maxDecoderDifference <= 1, 'Independent decoder rounding exceeded one sample');
}
if (index.routes) {
  const raw = read(index.routes.raw), matches = read(index.routes.matches);
  const points = [...raw.rows, ...lines(index.routes.seedPoints), ...lines(index.routes.searchPoints)];
  points.forEach(validateDecode);
  const pointKey = row => [row.image, row.quality, row.sha256].join('/');
  const observed = new Map(points.map(row => [pointKey(row), row]));
  const compare = point => {
    const row = observed.get(pointKey(point)); assert(row, 'Match references an absent measured stream');
    for (const field of ['image', 'bytes', 'quality']) assert.equal(point[field], row[field]);
    assert.deepEqual(point.metrics, row.metrics);
  };
  for (const match of matches.matches) {
    compare(match.reference);
    for (const metric of ['ssimulacra2', 'butteraugli']) {
      const result = match.metrics[metric];
      assert.equal(result.tolerance, tolerance(metric, match.reference.metrics[metric]));
      if (result.measured) compare(result.measured);
      if (result.bracket) result.bracket.forEach(compare);
      if (result.status === 'matched') {
        assert(Math.abs(result.measured.metrics[metric] - result.target) <= result.tolerance);
        assert.equal(result.candidateByteRatio, result.measured.bytes / match.reference.bytes);
      } else assert.equal(result.candidateByteRatio, null, 'An unmatched observation must not supply a matched byte ratio');
    }
    if (match.jointAtLeast) {
      compare(match.jointAtLeast);
      assert(match.jointAtLeast.metrics.ssimulacra2 >= match.reference.metrics.ssimulacra2 - .25);
      assert(match.jointAtLeast.metrics.butteraugli <= match.reference.metrics.butteraugli + tolerance('butteraugli', match.reference.metrics.butteraugli));
      assert.equal(match.jointAtLeast.candidateByteRatio, match.jointAtLeast.bytes / match.reference.bytes);
    }
  }
  const controls = raw.rows.filter(row => row.route === 'core-modular' && (row.quality === 100 || !index.routes.photos.includes(row.image)));
  for (const row of controls) {
    const after = raw.rows.find(x => x.route === 'candidate-core' && x.image === row.image && x.quality === row.quality);
    assert.equal(after?.sha256, row.sha256, 'An exact control changed');
  }
  summary.routes = {rows: raw.rows.length, independentDecodes: raw.rows.length * 2,
    additionalSearchRows: lines(index.routes.searchPoints).length, unchangedControlPairs: controls.length,
    seedChecksDuringSearch: matches.verifiedCandidateSeedStreams,
    tolerances: {ssimulacra2: .25, butteraugli: 'max(0.02, 2% of target)'}, metrics: {},
    jointAtLeastByteRatio: range(matches.matches.filter(m => m.jointAtLeast).map(m => m.jointAtLeast.candidateByteRatio)),
    fixedQuality85: raw.rows.filter(r => r.route === 'core-modular' && r.quality === 85 && index.routes.photos.includes(r.image)).map(before => {
      const after = raw.rows.find(r => r.route === 'candidate-core' && r.image === before.image && r.quality === before.quality);
      return {image: before.image, beforeBytes: before.bytes, afterBytes: after.bytes,
        beforeMs: before.ms, afterMs: after.ms, beforeMetrics: before.metrics, afterMetrics: after.metrics};
    })};
  for (const metric of ['ssimulacra2', 'butteraugli']) {
    const results = matches.matches.map(m => ({image: m.image, quality: m.quality, ...m.metrics[metric]}));
    summary.routes.metrics[metric] = {matchedByteRatio: range(results.filter(r => r.status === 'matched').map(r => r.candidateByteRatio)),
      unmatched: results.filter(r => r.status !== 'matched').map(r => ({image: r.image, quality: r.quality, status: r.status, target: r.target, tolerance: r.tolerance, deviation: r.deviation}))};
  }
}

summary.paired = [];
for (const descriptor of index.paired ?? []) {
  const raw = read(descriptor.file), rows = raw.rows.filter(r => !r.warmup), result = {name: descriptor.name, observations: raw.rows.length, settings: [], comparisons: []};
  const groups = new Map();
  for (const row of rows) {
    assert.equal(row.workerErrors, 0);
    const key = [row.runtime, row.variant, row.image, row.effort, row.quality].join('/');
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row);
  }
  for (const group of groups.values()) {
    const first = group[0]; assert.equal(group.length, raw.configuration.repeats);
    assert(group.every(r => r.sha256 === first.sha256 && r.bytes === first.bytes));
    result.settings.push({runtime: first.runtime, variant: first.variant, image: first.image, effort: first.effort, quality: first.quality,
      megapixels: first.width * first.height / 1e6, bytes: first.bytes, sha256: first.sha256,
      ms: range(group.map(r => r.ms)), workersStarted: [...new Set(group.map(r => r.workersStarted))]});
  }
  for (const comparison of descriptor.comparisons ?? []) for (const a of result.settings.filter(r => r.variant === comparison.before)) {
    const b = result.settings.find(r => r.runtime === a.runtime && r.image === a.image && r.effort === a.effort && r.quality === a.quality && r.variant === comparison.after);
    assert(b, 'Paired setting missing');
    if (comparison.equalOutput) assert.equal(a.sha256, b.sha256);
    const beforeRows = rows.filter(r => r.runtime === a.runtime && r.variant === comparison.before && r.image === a.image && r.effort === a.effort && r.quality === a.quality);
    const afterRows = rows.filter(r => r.runtime === a.runtime && r.variant === comparison.after && r.image === a.image && r.effort === a.effort && r.quality === a.quality);
    const ratios = beforeRows.map(r => r.ms / afterRows.find(s => s.round === r.round).ms);
    result.comparisons.push({name: comparison.name, runtime: a.runtime, image: a.image, effort: a.effort, quality: a.quality,
      beforeMs: a.ms.median, afterMs: b.ms.median, speedRatio: a.ms.median / b.ms.median,
      pairedSpeedRatio: range(ratios), fasterPairs: ratios.filter(r => r > 1).length,
      beforeBytes: a.bytes, afterBytes: b.bytes, beforeHelpers: a.workersStarted, afterHelpers: b.workersStarted});
  }
  summary.paired.push(result);
}
summary.matrices = []; const matrices = new Map();
for (const descriptor of index.matrices ?? []) {
  const rows = lines(descriptor.file); rows.forEach(validateDecode);
  assert.equal(new Set(rows.map(r => r.key)).size, rows.length, 'Duplicate observations');
  matrices.set(descriptor.name, rows);
  summary.matrices.push({name: descriptor.name, observations: rows.length, sourceHashes: [...new Set(rows.map(r => r.sourceHash))],
    runtimes: [...new Set(rows.map(r => r.runtime))], workerBudgets: [...new Set(rows.map(r => r.workersRequested))],
    images: [...new Set(rows.map(r => r.image))], inputHashes: [...new Set(rows.map(r => r.inputHash))]});
}
const settingsKey = row => [row.image, row.mode, row.effort, row.quality ?? null, row.distance ?? null].join('/');
summary.matrixComparisons = [];
for (const descriptor of index.matrixComparisons ?? []) {
  const before = new Map(matrices.get(descriptor.before).map(row => [settingsKey(row), row]));
  const pairs = [];
  for (const after of matrices.get(descriptor.after)) {
    const old = before.get(settingsKey(after)); if (!old) continue;
    assert.equal(old.inputHash, after.inputHash);
    if (descriptor.equalOutput) assert.equal(old.sha256, after.sha256, 'Exact stream identity failed');
    pairs.push({image: after.image, group: after.group, effort: after.effort, quality: after.quality, mode: after.mode,
      beforeKey: old.key, afterKey: after.key, identicalOutput: old.sha256 === after.sha256,
      byteRatio: after.bytes / old.bytes, speedRatio: old.ms / after.ms,
      ...(old.metrics && after.metrics ? {ssimulacra2Change: after.metrics.ssimulacra2 - old.metrics.ssimulacra2,
        butteraugliChange: after.metrics.butteraugli - old.metrics.butteraugli} : {})});
  }
  const aggregates = [];
  for (const mode of ['lossy', 'lossless']) for (const effort of [1, 3, 7, 9]) {
    const chosen = pairs.filter(r => r.mode === mode && r.effort === effort && r.image !== 'phone-flower-crop' &&
      (mode === 'lossless' || r.group.startsWith('photo')));
    if (!chosen.length) continue;
    aggregates.push({mode, effort, pairs: chosen.length, byteRatio: range(chosen.map(r => r.byteRatio)),
      speedRatio: range(chosen.map(r => r.speedRatio)),
      ...(mode === 'lossy' ? {ssimulacra2Change: range(chosen.map(r => r.ssimulacra2Change)), butteraugliChange: range(chosen.map(r => r.butteraugliChange))} : {})});
  }
  summary.matrixComparisons.push({name: descriptor.name, pairs: pairs.length, identicalOutputs: pairs.filter(r => r.identicalOutput).length, aggregates});
}
if (index.routes?.finalSeedMatrix) {
  const rows = matrices.get(index.routes.finalSeedMatrix), seeds = lines(index.routes.seedPoints);
  assert(rows);
  for (const seed of seeds) {
    const final = rows.find(row => settingsKey(row) === settingsKey(seed));
    assert(final, 'Final matrix lacks a reused seed setting');
    assert.equal(final.inputHash, seed.inputHash); assert.equal(final.sha256, seed.sha256);
    assert.deepEqual(final.metrics, seed.metrics);
  }
  summary.routes.finalSourceSeedChecks = seeds.length;
}
summary.native = [];
for (const descriptor of index.nativeComparisons ?? []) {
  const native = matrices.get(descriptor.native).filter(row => row.mode === 'lossy' && row.metrics);
  const timings = new Map((descriptor.nativeTiming ? matrices.get(descriptor.nativeTiming) : []).map(row => [row.key, row]));
  const references = matrices.get(descriptor.reference).filter(row => row.mode === 'lossy' && row.metrics &&
    (!descriptor.images || descriptor.images.includes(row.image)) && (!descriptor.qualities || descriptor.qualities.includes(row.quality)) &&
    (!descriptor.referenceEfforts || descriptor.referenceEfforts.includes(row.effort)));
  const matches = [];
  for (const reference of references) for (const effort of descriptor.nativeEfforts ?? [1, 3, 7, 9]) {
    const pool = native.filter(row => row.image === reference.image && row.effort === effort).sort((a, b) => a.distance - b.distance);
    if (!pool.length) continue;
    assert(pool.every(row => row.inputHash === reference.inputHash));
    for (const metric of ['ssimulacra2', 'butteraugli']) {
      const target = reference.metrics[metric], delta = row => row.metrics[metric] - target;
      let best = pool.reduce((a, b) => Math.abs(delta(a)) <= Math.abs(delta(b)) ? a : b);
      if (timings.has(best.key)) {
        const fresh = timings.get(best.key); assert.equal(fresh.sha256, best.sha256);
        assert.equal(fresh.inputHash, best.inputHash); assert.deepEqual(fresh.metrics, best.metrics); best = fresh;
      }
      const sign = row => (metric === 'ssimulacra2' ? 1 : -1) * delta(row);
      let bracket = null;
      for (let at = 1; at < pool.length; at++) if (sign(pool[at - 1]) >= 0 && sign(pool[at]) <= 0) { bracket = [pool[at - 1].key, pool[at].key]; break; }
      const allowed = tolerance(metric, target), status = Math.abs(delta(best)) <= allowed ? 'matched' : bracket ? 'bracketed' : 'outside-measured-range';
      matches.push({image: reference.image, referenceEffort: reference.effort, quality: reference.quality, nativeEffort: effort,
        runtime: reference.runtime, helpersRequested: reference.workersRequested, nativeThreads: best.libjxlWorkerThreads,
        referenceKey: reference.key, nativeKey: best.key, metric, target, tolerance: allowed, status, deviation: delta(best), bracket,
        referenceBytes: reference.bytes, nativeBytes: best.bytes, referenceMsPerMP: reference.msPerMP,
        nativeMsPerMP: best.msPerMP, nativeProcessWallMs: best.processWallMs,
        timingProvenance: timings.has(best.key) ? 'fresh-matched-replay' : 'native-observation-pool',
        byteRatio: status === 'matched' ? reference.bytes / best.bytes : null,
        timeRatio: status === 'matched' ? reference.ms / best.ms : null});
    }
  }
  const groups = [];
  for (const referenceEffort of [1, 3, 7, 9]) for (const nativeEffort of [1, 3, 7, 9]) for (const metric of ['ssimulacra2', 'butteraugli']) {
    const rows = matches.filter(r => r.referenceEffort === referenceEffort && r.nativeEffort === nativeEffort && r.metric === metric);
    if (!rows.length) continue;
    const valid = rows.filter(r => r.status === 'matched');
    groups.push({referenceEffort, nativeEffort, metric, targets: rows.length, matched: valid.length,
      freshTimingMatches: valid.filter(r => r.timingProvenance === 'fresh-matched-replay').length,
      bracketed: rows.filter(r => r.status === 'bracketed').length, outsideMeasuredRange: rows.filter(r => r.status === 'outside-measured-range').length,
      rapierNativeByteRatio: range(valid.map(r => r.byteRatio)), rapierNativeTimeRatio: range(valid.map(r => r.timeRatio)),
      rapierMsPerMP: range(valid.map(r => r.referenceMsPerMP)), nativeMsPerMP: range(valid.map(r => r.nativeMsPerMP))});
  }
  summary.native.push({name: descriptor.name, reference: descriptor.reference, native: descriptor.native,
    referenceImages: [...new Set(references.map(r => r.image))], targets: matches.length, groups,
    quality85: matches.filter(r => r.quality === 85), unmatched: matches.filter(r => r.status !== 'matched')});
}
summary.nativeChrome = [];
for (const descriptor of index.nativeChrome ?? []) {
  const receipt = read(descriptor.file); assert.equal(receipt.chrome, '155.0.8059.39');
  assert(!receipt.chromeCommandLine.some(arg => /enable.*(?:jxl|jpeg.?xl)/i.test(arg)), 'Experimental native decoder flag');
  const observations = receipt.rows.flatMap(row => Object.values(row.apis ?? {}));
  const failures = observations.filter(row => !row.passed);
  if (descriptor.expectPass) assert.equal(failures.length, 0, 'Candidate stream failed native Chrome qualification');
  if (descriptor.expectedFailures != null) assert.equal(failures.length, descriptor.expectedFailures);
  summary.nativeChrome.push({name: descriptor.name, streams: receipt.rows.length,
    testedStreams: receipt.rows.filter(row => row.apis).length, skippedStreams: receipt.rows.filter(row => row.skipped).length,
    apiObservations: observations.length, failures: failures.length, executableSha256: receipt.chromeExecutableSha256});
}
if (verification === '--check') {
  assert.deepEqual(read('summary.json'), summary, 'Generated summary differs from raw observations');
  console.log(JSON.stringify({checked: true, files: Object.keys(summary.inputs).length}));
} else console.log(JSON.stringify(summary, null, 2));
