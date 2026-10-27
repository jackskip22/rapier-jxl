// SPDX-License-Identifier: MIT
// Match decoded SSIMULACRA2, not quality-slider values. Keeps every probe.
// node bench/capture/match.mjs RESULTS.json --tools ../bench-tools --out ../capture-matched
import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {sha256} from '../image-io.mjs';

const args = process.argv.slice(2), arg = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const source = JSON.parse(readFileSync(args[0])), here = dirname(fileURLToPath(import.meta.url));
const tools = resolve(arg('--tools', '../bench-tools')), out = resolve(arg('--out', '../capture-matched'));
const fixtures = resolve(arg('--fixtures', here + '/fixtures')), only = new RegExp(arg('--only', '.*'));
mkdirSync(out, {recursive: true});
const reportPath = resolve(out, 'matched.json');
const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath)) : {schema: 1, libjxl: '0.12.0', rows: []};
report.method = 'Distance bisection, maximum 13 measured candidates plus zero-distance anchor, followed by at most 20 local probes when quantization prevents a match. Retain the smallest actual file within target..target+0.15; also record the smallest at/above target. If no match exists among the probes, report the achieved gap. CLI ms include input decode and file write. No interpolation of size or runtime.';
function run(name, argv) {
  const r = spawnSync(resolve(tools, 'libjxl12/tools', name), argv, {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 180000});
  if (r.error || r.status) throw r.error || new Error(r.stderr);
  return r;
}
for (const target of source.rows.filter(r => r.status === 'measured' && r.execution === 'main' && r.correctness?.ssimulacra2 < 99.999 &&
  (r.input === 'photo-keong' && (args.includes('--all-modules') || /^(core|photo|score)/.test(r.codec)) || r.input === 'snapdom-opaque-1920x1080' && r.codec === 'capture-error2') && only.test(r.key))) {
  const input = target.input === 'photo-keong' ? resolve(tools, 'photo-keong-rgba.png') : resolve(fixtures, target.input + '.png');
  for (const effort of [7, 9]) {
    const key = target.key + '/cjxl-e' + effort;
    const previous = report.rows.find(r => r.key === key);
    if (previous && (!args.includes('--refine') || previous.matched)) continue;
    const record = previous || {key, input: target.input, comparedCodec: target.codec, comparedBytes: target.bytes, targetScore: target.correctness.ssimulacra2, effort, probes: []};
    const equivalent = report.rows.find(r => r !== record && r.input === record.input && r.effort === effort && r.targetScore === record.targetScore && r.status === 'measured' && r.matched);
    if (equivalent) {
      Object.assign(record, {probes: equivalent.probes, chosen: equivalent.chosen, scoreGap: equivalent.scoreGap, matched: equivalent.matched,
        comparedBytePercent: 100 * (record.comparedBytes / equivalent.chosen.bytes - 1), status: 'measured', reusedMeasurement: equivalent.key});
      if (!previous) report.rows.push(record); writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); continue;
    }
    const prefix = resolve(out, key.replaceAll('/', '--'));
    const probe = distance => {
      const existing = record.probes.find(p => p.distance === distance);
      if (existing) return existing;
      const file = prefix + '-d' + String(distance) + '.jxl', png = file + '.png';
      const start = performance.now();
      run('cjxl', [input, file, '-d', String(distance), '-e', String(effort), '--num_threads=1', '--lossless_jpeg=0', '--quiet']);
      const ms = performance.now() - start;
      run('djxl', [file, png, '--bits_per_sample=8']);
      const score = Number(run('ssimulacra2', [input, png]).stdout.trim()), data = readFileSync(file);
      const p = {distance, bytes: data.length, ssimulacra2: score, ms, sha256: sha256(data)};
      record.probes.push(p); return p;
    };
    try {
      if (!previous) {
        let low = 0, high = 6;
        probe(0);
        for (let i = 0; i < 13; i++) {
          const distance = i === 0 ? high : (low + high) / 2;
          const p = probe(distance);
          if (p.ssimulacra2 >= record.targetScore) low = distance;
          else high = distance;
          if (p.ssimulacra2 >= record.targetScore && p.ssimulacra2 - record.targetScore <= 0.08) break;
        }
      }
      const isMatch = p => p.ssimulacra2 >= record.targetScore && p.ssimulacra2 - record.targetScore <= 0.15;
      if (!record.probes.some(isMatch)) {
        const center = [...record.probes].sort((a,b)=>Math.abs(a.ssimulacra2-record.targetScore)-Math.abs(b.ssimulacra2-record.targetScore))[0].distance;
        for (let i = 1; i <= 10; i++) {
          for (const direction of [1,-1]) probe(Math.max(0.000001, Number((center + direction * i * 0.001).toFixed(9))));
          if (record.probes.some(isMatch)) break;
        }
      }
      record.smallestAtOrAbove = record.probes.filter(p => p.ssimulacra2 >= record.targetScore).sort((a,b)=>a.bytes-b.bytes)[0];
      record.chosen = record.probes.filter(isMatch).sort((a,b)=>a.bytes-b.bytes)[0] || record.smallestAtOrAbove;
      record.scoreGap = record.chosen.ssimulacra2 - record.targetScore;
      record.matched = record.scoreGap <= 0.15;
      record.comparedBytePercent = 100 * (record.comparedBytes / record.chosen.bytes - 1);
      record.status = 'measured';
    } catch (error) { record.status = 'failed'; record.error = error.message; }
    if (!previous) report.rows.push(record); writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({...record, probes: record.probes.length}));
  }
}
