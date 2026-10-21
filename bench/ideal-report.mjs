#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Summarize actual protocol rows; missing or bracketed quality matches stay missing/bracketed.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {dirname, resolve, join} from 'node:path';

const [manifestPath, outputPath] = process.argv.slice(2);
assert(manifestPath && outputPath, 'Use ideal-report.mjs DATASETS.json OUTPUT_DIRECTORY');
const base = dirname(resolve(manifestPath)), spec = JSON.parse(readFileSync(manifestPath, 'utf8'));
const out = resolve(outputPath); mkdirSync(out, {recursive: true});
const readLines = path => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const median = values => { const a = [...values].sort((a, b) => a - b), m = a.length >> 1; return a.length ? a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2 : null; };
const stats = values => values.length ? {count: values.length, median: median(values), min: Math.min(...values), max: Math.max(...values)} : {count: 0, median: null, min: null, max: null};
const settingsKey = row => JSON.stringify([row.image, row.mode, row.effort, row.quality]);
function readDataset(value) {
  const item = typeof value === 'string' ? {path: value} : value, path = resolve(base, item.path);
  let rows = readLines(join(path, 'results.jsonl'));
  if (item.identityHash) rows = rows.filter(row => row.identityHash === item.identityHash);
  const identities = [...new Set(rows.map(row => row.identityHash))];
  assert(identities.length <= 1, 'Select an identityHash for the mixed dataset ' + path);
  assert.equal(new Set(rows.map(row => row.key)).size, rows.length, 'Duplicate result rows in ' + path);
  return {path, identities, rows, matches: readLines(join(path, 'matches.jsonl')).filter(row => !item.identityHash || row.identityHash === item.identityHash)};
}
const datasets = Object.fromEntries(Object.entries(spec.datasets).map(([name, value]) => [name, readDataset(value)]));
const coverage = Object.fromEntries(Object.entries(datasets).map(([name, data]) => [name, {
  identities: data.identities, rows: data.rows.length, images: [...new Set(data.rows.map(row => row.image))],
  sourceHashes: [...new Set(data.rows.map(row => row.sourceHash))],
  modes: Object.fromEntries(['lossy', 'lossless'].map(mode => [mode, data.rows.filter(row => row.mode === mode).length])),
  exactLossless: data.rows.filter(row => row.mode === 'lossless' && row.exact).length,
  alphaChanges: data.rows.reduce((sum, row) => sum + Object.values(row.decodes).reduce((n, decoder) => n + decoder.alphaChangedSamples, 0), 0),
  workerErrors: data.rows.reduce((sum, row) => sum + (row.workerErrors || 0), 0),
}]));

const comparisons = [];
for (const pair of spec.comparisons || []) {
  const before = datasets[pair.before], after = datasets[pair.after]; assert(before && after, 'Unknown comparison dataset');
  const lookup = new Map(before.rows.map(row => [settingsKey(row), row]));
  for (const current of after.rows) {
    const old = lookup.get(settingsKey(current)); if (!old) continue;
    assert.equal(old.inputHash, current.inputHash, 'Comparison source pixels differ');
    assert.equal(old.runtime, current.runtime, 'Compare runtimes separately');
    comparisons.push({comparison: pair.name || pair.before + ' to ' + pair.after, before: pair.before, after: pair.after,
      beforeKey: old.key, afterKey: current.key, image: current.image, group: current.group, runtime: current.runtime,
      mode: current.mode, effort: current.effort, quality: current.quality, workersRequested: current.workersRequested,
      beforeBytes: old.bytes, afterBytes: current.bytes, byteChange: current.bytes - old.bytes, byteRatio: current.bytes / old.bytes,
      beforeMsPerMP: old.msPerMP, afterMsPerMP: current.msPerMP, speedup: old.ms / current.ms,
      beforeSamples: old.samples, afterSamples: current.samples, identicalOutput: old.sha256 === current.sha256,
      ...(current.metrics && old.metrics ? {beforeMetrics: old.metrics, afterMetrics: current.metrics,
        ssimulacra2Change: current.metrics.ssimulacra2 - old.metrics.ssimulacra2,
        butteraugliChange: current.metrics.butteraugli - old.metrics.butteraugli,
        bothMetricsImproved: current.metrics.ssimulacra2 > old.metrics.ssimulacra2 && current.metrics.butteraugli < old.metrics.butteraugli} : {}),
    });
  }
}
const summaries = [];
for (const name of [...new Set(comparisons.map(row => row.comparison))]) for (const family of ['photo', 'graphics', 'lossless']) for (const effort of [1, 3, 7, 9]) {
  // The full phone and its crop are correlated: use full phone in the main before/after photo aggregate.
  const rows = comparisons.filter(row => row.comparison === name && row.effort === effort && row.image !== 'phone-flower-crop' &&
    (family === 'lossless' ? row.mode === 'lossless' : row.mode === 'lossy' && row.group.startsWith('photo') === (family === 'photo')));
  if (!rows.length) continue;
  summaries.push({comparison: name, family, mode: rows[0].mode, effort, cases: rows.length, images: [...new Set(rows.map(row => row.image))],
    byteRatio: stats(rows.map(row => row.byteRatio)), speedup: stats(rows.map(row => row.speedup)),
    identicalOutputs: rows.filter(row => row.identicalOutput).length,
    ...(rows[0].beforeMetrics ? {ssimulacra2Change: stats(rows.map(row => row.ssimulacra2Change)),
      butteraugliChange: stats(rows.map(row => row.butteraugliChange)), bothMetricsImproved: rows.filter(row => row.bothMetricsImproved).length} : {})});
}

const workers = [];
for (const pair of spec.workerComparisons || []) {
  const serial = datasets[pair.serial], parallel = datasets[pair.parallel]; assert(serial && parallel, 'Unknown worker dataset');
  const lookup = new Map(serial.rows.map(row => [settingsKey(row), row]));
  for (const row of parallel.rows) {
    const old = lookup.get(settingsKey(row)); if (!old) continue;
    assert.equal(old.inputHash, row.inputHash); assert.equal(old.sourceHash, row.sourceHash, 'Worker comparison must use the same source graph');
    workers.push({name: pair.name || pair.parallel, image: row.image, runtime: row.runtime, mode: row.mode, effort: row.effort, quality: row.quality,
      serialKey: old.key, parallelKey: row.key, serialMsPerMP: old.msPerMP, parallelMsPerMP: row.msPerMP, speedup: old.ms / row.ms,
      peakHelpers: row.peakHelpers, workersPerSample: row.samples.map(sample => sample.workersStarted),
      workerTasksPerSample: row.samples.map(sample => sample.workerTasks), workerErrors: row.workerErrors,
      identicalOutput: old.sha256 === row.sha256});
  }
}

const matched = [];
for (const name of spec.native || []) {
  for (const row of datasets[name].matches) {
    if (spec.referenceEffort !== undefined && row.reference.effort !== spec.referenceEffort) continue;
    if (spec.matchedImages && !spec.matchedImages.includes(row.image)) continue;
    for (const [metric, match] of Object.entries(row.metrics)) matched.push({nativeDataset: name, matchKey: row.key, referenceKey: row.referenceKey,
      referenceLabel: row.reference.label, referenceSourceHash: row.reference.sourceHash, image: row.image,
      referenceEffort: row.reference.effort, quality: row.reference.quality, libjxlEffort: row.effort, metric, status: match.status,
      target: match.target, tolerance: match.tolerance, deviation: match.deviation,
      referenceBytes: row.reference.bytes, measured: match.measured, bracket: match.bracket,
      // No ratio is asserted for a target that has only a measured bracket.
      byteRatio: match.status === 'matched' ? row.reference.bytes / match.measured.bytes : null,
      jointAtLeast: row.jointAtLeast});
  }
}
const matchedSummaries = [];
for (const source of [...new Set(matched.map(row => row.referenceSourceHash))]) for (const effort of [1, 3, 7, 9]) for (const metric of ['ssimulacra2', 'butteraugli']) {
  const rows = matched.filter(row => row.referenceSourceHash === source && row.libjxlEffort === effort && row.metric === metric);
  if (!rows.length) continue;
  const valid = rows.filter(row => row.status === 'matched');
  matchedSummaries.push({referenceSourceHash: source, referenceLabel: rows[0].referenceLabel, libjxlEffort: effort, metric,
    comparisons: rows.length, matched: valid.length, bracketed: rows.filter(row => row.status === 'bracketed').length,
    outsideMeasuredRange: rows.filter(row => row.status === 'outside-measured-range').length,
    byteRatio: stats(valid.map(row => row.byteRatio)), images: [...new Set(rows.map(row => row.image))]});
}
const report = {generatedAt: new Date().toISOString(), notes: [
  'All summaries derive from actual completed rows; no missing observation is estimated.',
  'The main photo before/after aggregate excludes phone-flower-crop to avoid counting its original twice. Raw rows retain it for iteration and worker-threshold checks.',
  'Native photographic matches use the explicitly listed inputs. The phone crop stands in for that original in this diagnostic matched-quality set.',
  'Higher SSIMULACRA2 and lower Butteraugli are better. Separate metric matches need separate byte ratios.',
  'Ratios below one mean smaller Rapier output at an actually matched native quality; bracketed targets have no ratio.',
  'Rapier timing spans complete in-memory API encode; native timing comes from rounded reported encoder MP/s, with process-wall observations retained separately.',
], coverage, summaries, comparisons, workers, matchedSummaries, matched};
writeFileSync(join(out, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
const fmt = (value, digits = 3) => value == null ? '—' : Number(value).toFixed(digits);
const lines = ['# Measured encoder comparison', '', ...report.notes.map(note => '- ' + note), '', '## Actual coverage', '',
  '| Dataset | Completed rows | Images | Lossy | Lossless | Exact lossless | Alpha changes | Worker errors |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
for (const [name, row] of Object.entries(coverage)) lines.push(`| ${name} | ${row.rows} | ${row.images.length} | ${row.modes.lossy} | ${row.modes.lossless} | ${row.exactLossless} | ${row.alphaChanges} | ${row.workerErrors} |`);
lines.push('', '## Before and after', '', '| Comparison | Family | Effort | Cases | Median byte ratio | Median speedup | Speedup range | Same output |', '| --- | --- | ---: | ---: | ---: | ---: | --- | ---: |');
for (const row of summaries) lines.push(`| ${row.comparison} | ${row.family} | ${row.effort} | ${row.cases} | ${fmt(row.byteRatio.median, 5)} | ${fmt(row.speedup.median)}× | ${fmt(row.speedup.min)}–${fmt(row.speedup.max)}× | ${row.identicalOutputs} |`);
lines.push('', '## Separate matched-quality comparisons', '', '| Reference | Native effort | Metric | Matched / total | Bracketed | Median Rapier / native bytes | Range |', '| --- | ---: | --- | ---: | ---: | ---: | --- |');
for (const row of matchedSummaries) lines.push(`| ${row.referenceLabel} | ${row.libjxlEffort} | ${row.metric} | ${row.matched}/${row.comparisons} | ${row.bracketed} | ${fmt(row.byteRatio.median)} | ${fmt(row.byteRatio.min)}–${fmt(row.byteRatio.max)} |`);
lines.push('', '## Worker observations', '', '| Dataset | Input | Mode | Effort | Quality | Peak helpers | Serial ms/MP | Parallel ms/MP | Speedup | Same output |', '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
for (const row of workers) lines.push(`| ${row.name} | ${row.image} | ${row.mode} | ${row.effort} | ${row.quality ?? 'exact'} | ${row.peakHelpers} | ${fmt(row.serialMsPerMP, 1)} | ${fmt(row.parallelMsPerMP, 1)} | ${fmt(row.speedup)}× | ${row.identicalOutput} |`);
lines.push('', 'See `summary.json` for every paired observation, both metric changes, raw timing samples, source identities, and actual native matching brackets.', '');
writeFileSync(join(out, 'report.md'), lines.join('\n'));
console.log(JSON.stringify({output: out, datasets: Object.keys(coverage).length, pairedRows: comparisons.length, workerPairs: workers.length, qualityMatches: matched.length}));
