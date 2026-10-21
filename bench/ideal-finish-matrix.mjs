#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Bounded final matrix. Run heavy phases under the host's shared measurement lock.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const [configuration, destination, phase] = process.argv.slice(2);
assert(configuration && destination && ['candidate', 'native'].includes(phase),
  'Use ideal-finish-matrix.mjs CONFIG.json OUTPUT_DIRECTORY candidate|native');
assert.equal(process.version, 'v22.23.3');
const here = dirname(fileURLToPath(import.meta.url)), base = dirname(resolve(configuration));
const configBytes = readFileSync(configuration), config = JSON.parse(configBytes), out = resolve(destination);
const path = value => resolve(base, value), run = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const lines = file => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const photos = ['photo-keong', 'photo-ria', 'photo-bliznaca', 'phone-flower-crop', 'phone-flower'];
mkdirSync(out, {recursive: true});
const logFile = join(out, phase + '-commands.json'), commands = existsSync(logFile) ? JSON.parse(readFileSync(logFile)) : [];
const save = () => writeFileSync(logFile, JSON.stringify(commands, null, 2) + '\n');
async function observe(dataset, runtime, workers, extra) {
  const args = [join(here, 'ideal.mjs'), '--corpus', path(config.corpus), '--out', join(out, dataset),
    '--tools', path(config.tools), '--oxide', path(config.oxide), '--runtime', runtime, '--workers', String(workers),
    '--warmups', String(config.warmups ?? 1), '--repeats', String(config.repeats ?? 3), '--label', dataset];
  if (runtime !== 'libjxl') args.push('--encoder', path(config.encoder));
  if (runtime === 'chrome') args.push('--chrome', path(config.chrome), '--playwright', path(config.playwright));
  args.push(...extra);
  const receipt = {startedAt: new Date().toISOString(), configurationSha256: hash(configBytes), command: [process.execPath, ...args]};
  commands.push(receipt); save();
  const result = await run(process.execPath, args, {timeout: 3600000, maxBuffer: 1 << 24});
  receipt.completedAt = new Date().toISOString(); receipt.exitCode = 0; receipt.stdout = result.stdout.trim(); save();
  console.log(JSON.stringify({dataset, runtime, workers, ...receipt}));
}

if (phase === 'candidate') {
  for (const runtime of ['node', 'chrome']) {
    const serial = 'candidate-' + runtime, parallel = serial + '-workers';
    await observe(serial, runtime, 0, ['--modes', 'lossy', '--ids', photos.join(','), '--efforts', '1,7', '--qualities', '60,75,85,90,95']);
    await observe(serial, runtime, 0, ['--modes', 'lossy', '--ids', 'ui-gd-paint,alpha-globe,scan-tenniel', '--efforts', '1', '--qualities', '75,90']);
    await observe(serial, runtime, 0, ['--modes', 'lossless', '--ids', 'ui-gd-paint,alpha-globe,scan-tenniel,hdr-room,ui-editor,alpha-isotiles,graphics-splines,phone-flower,alpha-flower', '--efforts', '1,3']);
    await observe(parallel, runtime, 3, ['--modes', 'lossy', '--ids', 'phone-flower-crop,phone-flower', '--efforts', '1,7', '--qualities', '85']);
    await observe(parallel, runtime, 3, ['--modes', 'lossless', '--ids', 'graphics-splines,alpha-flower,scan-tenniel,phone-flower,ui-editor,hdr-room', '--efforts', '1,3']);
  }
} else {
  for (const [name, seed] of [['libjxl-serial', config.nativeSerialSeed], ['libjxl-parallel', config.nativeParallelSeed]]) {
    const directory = join(out, name); mkdirSync(directory, {recursive: true});
    if (!seed || existsSync(join(directory, 'results.jsonl'))) continue;
    const source = path(seed), bytes = readFileSync(join(source, 'results.jsonl'));
    copyFileSync(join(source, 'results.jsonl'), join(directory, 'results.jsonl'));
    for (const file of readdirSync(source).filter(name => /^environment-.*\.json$/.test(name))) copyFileSync(join(source, file), join(directory, file));
    writeFileSync(join(directory, 'seed-provenance.json'), JSON.stringify({source, resultsSha256: hash(bytes), rows: lines(join(source, 'results.jsonl')).length,
      note: 'Real earlier observations of immutable native tools and the identical corpus/protocol. Output hashes and decode evidence are retained; new observations append.'}, null, 2) + '\n');
  }
  const candidate = lines(join(out, 'candidate-node', 'results.jsonl')), release = lines(join(path(config.releaseNode), 'results.jsonl'));
  const references = [...release, ...candidate].filter(row => row.mode === 'lossy' && row.effort === 7 && photos.includes(row.image) &&
    (row.image !== 'phone-flower' || row.quality === 85));
  assert.equal(references.length, 42, 'Expected two sources, four five-quality inputs and the full phone at quality 85');
  const refs = join(out, 'native-references.jsonl'); writeFileSync(refs, references.map(row => JSON.stringify(row)).join('\n') + '\n');
  await observe('libjxl-serial', 'libjxl', 0, ['--modes', 'lossy', '--ids', photos.join(','), '--efforts', '1,7', '--distances', ',', '--match', refs, '--matchSteps', '7']);

  // Measure the exact serial-selected quality settings with four native threads.
  // A candidate does not inherit a score or byte count across thread budgets.
  const environments = readdirSync(join(out, 'libjxl-serial')).filter(name => /^environment-.*\.json$/.test(name)).map(name => JSON.parse(readFileSync(join(out, 'libjxl-serial', name))));
  const environment = environments.find(row => row.label === 'libjxl-serial'); assert(environment);
  const serial = lines(join(out, 'libjxl-serial', 'results.jsonl'));
  assert(serial.every(row => row.identityHash === environment.identityHash), 'Seed and current native tool/corpus/protocol identities differ; start without the seed');
  for (const image of photos) for (const effort of [1, 7]) {
    const pool = serial.filter(row => row.image === image && row.effort === effort && row.mode === 'lossy');
    const distances = new Set();
    for (const reference of references.filter(row => row.image === image && row.quality === 85)) for (const metric of ['ssimulacra2', 'butteraugli']) {
      const delta = row => Math.abs(row.metrics[metric] - reference.metrics[metric]);
      const nearest = pool.reduce((a, b) => !a || delta(b) < delta(a) ? b : a, null); assert(nearest);
      distances.add(nearest.distance);
    }
    const settings = ['--modes', 'lossy', '--ids', image, '--efforts', String(effort), '--distances', [...distances].sort((a, b) => a - b).join(',')];
    await observe('libjxl-serial-timing', 'libjxl', 0, settings);
    if (image === 'phone-flower-crop' || image === 'phone-flower') await observe('libjxl-parallel', 'libjxl', 3, settings);
  }
}
console.log(JSON.stringify({phase, output: out, commands: commands.length}));
