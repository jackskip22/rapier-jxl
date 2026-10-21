#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Match actual core targets using the main harness; every byte ratio names an observed stream.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {dirname, resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const [configuration, destination] = process.argv.slice(2);
assert(configuration && destination, 'Use ideal-route-match.mjs CONFIG.json OUTPUT_DIRECTORY');
assert.equal(process.version, 'v22.23.3');
const base = dirname(resolve(configuration)), config = JSON.parse(readFileSync(configuration)), out = resolve(destination);
const path = value => resolve(base, value), run = promisify(execFile), here = dirname(fileURLToPath(import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const lines = file => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const routeBytes = readFileSync(path(config.routes)), routes = JSON.parse(routeBytes), seedFile = path(config.seeds);
const references = routes.rows.filter(r => r.route === 'core-modular' && r.quality < 100 && config.images.includes(r.image));
const candidate = routes.rows.filter(r => r.route === 'candidate-core' && r.quality < 100 && config.images.includes(r.image));
const seeds = lines(seedFile).filter(r => r.mode === 'lossy' && r.effort === 1 && config.images.includes(r.image));
// Earlier source measurements remain valid only where the newly measured prototype emits the exact stream.
for (const row of candidate) {
  const seed = seeds.find(s => s.image === row.image && s.quality === row.quality);
  assert(seed && seed.inputHash === row.inputHash && seed.sha256 === row.sha256, 'Candidate route differs from seed at ' + row.image + '/' + row.quality);
  assert.deepEqual(seed.metrics, row.metrics, 'The identical stream has different quality observations');
}
mkdirSync(out, {recursive: true}); const measured = join(out, 'measurements');
const report = {startedAt: new Date().toISOString(), config, identities: {routes: hash(routeBytes), seeds: hash(readFileSync(seedFile)), harness: hash(readFileSync(fileURLToPath(import.meta.url)))},
  seedSourceHashes: [...new Set(seeds.map(r => r.sourceHash))], verifiedCandidateSeedStreams: candidate.length,
  protocol: 'Core Modular target versus candidate photo output. Separate SSIMULACRA2 and Butteraugli matches; actual measured qualities only. Candidate search observations have one sample and no warmup, used for bytes/quality, not speed claims.',
  matches: [], newObservations: []};
const compact = row => ({key: row.key, image: row.image, quality: row.quality, bytes: row.bytes, sha256: row.sha256, metrics: row.metrics,
  sourceHash: row.sourceHash, provenance: row.key ? 'complete-api-measurement' : 'core-route-measurement'});
const points = image => [...seeds, ...lines(join(measured, 'results.jsonl'))].filter(r => r.image === image && r.mode === 'lossy' && r.effort === 1);
const persist = () => writeFileSync(join(out, 'raw.json'), JSON.stringify(report, null, 2) + '\n'); persist();
for (const reference of references) {
  const match = {image: reference.image, quality: reference.quality, reference: compact(reference), metrics: {}};
  for (const metric of ['ssimulacra2', 'butteraugli']) {
    const target = reference.metrics[metric], tolerance = metric === 'ssimulacra2' ? .25 : Math.max(.02, target * .02);
    const sign = row => (metric === 'ssimulacra2' ? 1 : -1) * (row.metrics[metric] - target);
    let best, bracket;
    for (let step = 0; step <= (config.steps ?? 7); step++) {
      const pool = points(reference.image).sort((a, b) => a.quality - b.quality);
      best = pool.reduce((a, b) => !a || Math.abs(sign(b)) < Math.abs(sign(a)) ? b : a, null); bracket = null;
      for (let i = 1; i < pool.length; i++) if (sign(pool[i - 1]) <= 0 && sign(pool[i]) >= 0) { bracket = [pool[i - 1], pool[i]]; break; }
      if (best && Math.abs(sign(best)) <= tolerance || step === (config.steps ?? 7)) break;
      const quality = !bracket ? (!pool.length || sign(pool.at(-1)) < 0 ? 99.9 : 1) :
        Number((bracket[0].quality + (bracket[1].quality - bracket[0].quality) * Math.max(.1, Math.min(.9, -sign(bracket[0]) / (sign(bracket[1]) - sign(bracket[0]))))).toFixed(6));
      if (pool.some(row => row.quality === quality)) break;
      const args = [join(here, 'ideal.mjs'), '--corpus', path(config.corpus), '--out', measured, '--encoder', path(config.encoder),
        '--label', 'candidate-route-quality-search', '--tools', path(config.tools), '--oxide', path(config.oxide),
        '--runtime', 'node', '--workers', '0', '--modes', 'lossy', '--ids', reference.image,
        '--efforts', '1', '--qualities', String(quality), '--warmups', '0', '--repeats', '1'];
      const result = await run(process.execPath, args, {timeout: 300000, maxBuffer: 1 << 22});
      report.newObservations.push({image: reference.image, quality, command: [process.execPath, ...args], output: result.stdout.trim()}); persist();
    }
    const status = best && Math.abs(sign(best)) <= tolerance ? 'matched' : bracket ? 'bracketed' : 'outside-measured-range';
    match.metrics[metric] = {status, target, tolerance, deviation: best ? best.metrics[metric] - target : null,
      measured: best ? compact(best) : null, bracket: bracket?.map(compact) ?? null, candidateByteRatio: status === 'matched' ? best.bytes / reference.bytes : null};
  }
  const eligible = points(reference.image).filter(row => row.metrics.ssimulacra2 >= reference.metrics.ssimulacra2 - .25 &&
    row.metrics.butteraugli <= reference.metrics.butteraugli + Math.max(.02, reference.metrics.butteraugli * .02)).sort((a, b) => a.bytes - b.bytes);
  match.jointAtLeast = eligible.length ? {...compact(eligible[0]), candidateByteRatio: eligible[0].bytes / reference.bytes} : null;
  report.matches.push(match); persist(); console.log(JSON.stringify(match));
}
report.completedAt = new Date().toISOString(); persist();
