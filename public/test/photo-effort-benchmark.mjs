// SPDX-License-Identifier: MIT
// Named photo effort measurements; no timing assertions. Each encode is isolated for peak resident memory.
// --inputs is an array of {id,kind,width,height,pixels,rgbaHash}; --photos uses the licensed photo-corpus.json.
// node test/photo-effort-benchmark.mjs --photos=/tmp/photos --work=/tmp/photo-effort --repeat=3 --output=/tmp/photo-effort.json
// Add --native=/path/native-decoder for decoded integer RGB error, and --rs=/path/rapier_oracle for all three oracles.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {spawnSync, execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve, join, dirname, relative} from 'node:path';
import {cpus, platform, arch} from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {nativeDecoder} from './native-decoder.mjs';
import {decoder} from './decoder.mjs';
import {jxlRsDecoder, decoderDifference} from './jxl-rs-decoder.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(arg => { const [key, ...value] = arg.replace(/^--/, '').split('='); return [key, value.join('=') || true]; }));
const here = fileURLToPath(new URL('.', import.meta.url)), self = fileURLToPath(import.meta.url);
const source = resolve(args.source || fileURLToPath(new URL('../../', import.meta.url))), hash = data => createHash('sha256').update(data).digest('hex');
const numeric = (name, fallback, minimum, maximum, integer = true) => {
  assert.ok(args[name] === undefined || typeof args[name] === 'string', '--' + name + ' requires a value');
  const value = args[name] === undefined ? fallback : Number(args[name]);
  assert.ok(Number.isFinite(value) && value >= minimum && value <= maximum && (!integer || Number.isSafeInteger(value)), 'invalid --' + name);
  return value;
};
const quality = numeric('quality', 90, 1, 100, false), effort = numeric('effort', 5, 1, 9);
const previousEffort = numeric('previous', 4, 1, 9), repeat = numeric('repeat', 3, 1, Number.MAX_SAFE_INTEGER);
const start = numeric('start', 0, 0, Number.MAX_SAFE_INTEGER);
const count = args.count === undefined ? null : numeric('count', 1, 1, Number.MAX_SAFE_INTEGER);
if (args.encode) {
  const {encodePhoto} = await import(pathToFileURL(join(source, 'photo.mjs'))), data = readFileSync(args.encode);
  const cpu = process.cpuUsage(), start = performance.now();
  const bytes = encodePhoto(data, Number(args.width), Number(args.height), {quality, effort});
  const ms = performance.now() - start, used = process.cpuUsage(cpu);
  const peakRssKiB = process.platform === 'linux' ? Number(readFileSync('/proc/self/status', 'utf8').match(/^VmHWM:\s+(\d+)/m)[1]) : process.resourceUsage().maxRSS;
  writeFileSync(args.encoded, bytes);
  console.log(JSON.stringify({bytes: bytes.length, sha256: hash(bytes), ms, cpuMs: (used.user + used.system) / 1000, peakRssKiB}));
  process.exit(0);
}
assert.ok(previousEffort <= effort, '--previous must not exceed --effort');
// Record every module reachable by the actual photo entry before importing it, then reject source drift after
// the run. Production imports are literal relative ES-module paths; no encoder module is fetched at runtime.
function sourceHashes() {
  const hashes = {}, visit = path => {
    const name = relative(source, path);
    if (Object.hasOwn(hashes, name)) return;
    const bytes = readFileSync(path), code = bytes.toString('utf8');
    hashes[name] = hash(bytes);
    for (const match of code.matchAll(/(?:\bfrom\s*|\bimport\s*)(['"])(\.[^'"]+)\1/g)) visit(resolve(dirname(path), match[2]));
  };
  visit(join(source, 'photo.mjs'));
  return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
const sources = sourceHashes(), programHash = hash(readFileSync(self));
const {complete} = await import(pathToFileURL(join(source, 'bits.mjs')));
const {photoCoefficientSteps} = await import(pathToFileURL(join(source, 'photo-dct.mjs')));
const {quantisationSteps} = await import(pathToFileURL(join(source, 'photo-quant.mjs')));
assert.ok(args.inputs || args.photos, 'Name --inputs or --photos');
const work = resolve(args.work || '.photo-effort');
mkdirSync(work, {recursive: true});
let inputs = args.inputs ? JSON.parse(readFileSync(args.inputs, 'utf8')) : [];
assert.ok(Array.isArray(inputs), '--inputs must contain a JSON array');
if (args.photos) {
  const manifest = JSON.parse(readFileSync(join(here, 'photo-corpus.json'), 'utf8'));
  for (const photo of manifest.photos) {
    const input = join(resolve(args.photos), photo.id + '.jpg'), bytes = readFileSync(input);
    assert.equal(hash(bytes), photo.sha256, photo.id + ': source hash');
    const {width, height} = JSON.parse(execFileSync(args.ffprobe || 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', input], {encoding: 'utf8'})).streams[0];
    const data = execFileSync(args.ffmpeg || 'ffmpeg', ['-v', 'error', '-threads', '1', '-i', input, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], {maxBuffer: width * height * 4 + 65536});
    const pixels = join(work, photo.id + '.rgba');
    writeFileSync(pixels, data);
    inputs.push({id: photo.id, kind: 'photograph', width, height, pixels, rgbaHash: hash(data), sourceHash: photo.sha256});
  }
}
assert.ok(inputs.length > 0, 'the input manifest is empty');
assert.ok(start < inputs.length, '--start is outside the input manifest');
assert.ok(count === null || count <= inputs.length - start, '--count exceeds the input manifest');
inputs = inputs.slice(start, count === null ? undefined : start + count);
const median = samples => samples.slice().sort((a, b) => a - b)[samples.length >> 1];
const native = args.native ? await nativeDecoder({executable: args.native}) : null;
const rust = args.rs ? jxlRsDecoder({executable: args.rs}) : null, oxide = args.rs ? await decoder() : null;
if (args.rs) assert.ok(rust && native && oxide, '--rs requires working Rust, native and jxl-oxide decoders');
const toRGBA = image => {
  const data = new Uint8Array(image.width * image.height * 4);
  for (let i = 0; i < image.width * image.height; i++) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = image.data[i * image.channels + (image.channels <= 2 ? 0 : c)];
    data[i * 4 + 3] = image.channels === 4 ? image.data[i * 4 + 3] : image.channels === 2 ? image.data[i * 2 + 1] : 255;
  }
  return data;
};
const rgbSse = (data, back) => {
  let error = 0;
  for (let i = 0; i < data.length; i++) if (i % 4 === 3) assert.equal(back[i], data[i], 'alpha is exact'); else error += (data[i] - back[i]) * (data[i] - back[i]);
  return error;
};
const rows = [];
try {
  for (const input of inputs) {
    const {id, width, height, pixels} = input, data = readFileSync(pixels);
    assert.equal(data.length, width * height * 4, id + ': RGBA size');
    if (input.rgbaHash) assert.equal(hash(data), input.rgbaHash, id + ': RGBA hash');
    const run = level => {
      const samples = [], encoded = join(work, id + '-e' + level + '.jxl');
      for (let i = 0; i < repeat; i++) {
        const child = spawnSync(process.execPath, [self, '--encode=' + pixels, '--encoded=' + encoded, '--source=' + source,
          '--width=' + width, '--height=' + height, '--quality=' + quality, '--effort=' + level], {encoding: 'utf8', maxBuffer: 65536});
        assert.ifError(child.error); assert.equal(child.status, 0, child.stderr);
        samples.push(JSON.parse(child.stdout));
      }
      assert.ok(samples.every(sample => sample.sha256 === samples[0].sha256), id + ': deterministic repeated bytes');
      return {encoded, bytes: samples[0].bytes, sha256: samples[0].sha256, ms: median(samples.map(s => s.ms)), cpuMs: median(samples.map(s => s.cpuMs)), peakRssKiB: Math.max(...samples.map(s => s.peakRssKiB))};
    };
    const baseline = run(1), previous = run(previousEffort), candidate = run(effort);
    assert.ok(candidate.bytes <= previous.bytes && previous.bytes <= baseline.bytes, id + ': effort cannot enlarge the stream');
    const row = {...input, rgbaHash: hash(data), baseline, previous, candidate, gain: 1 - candidate.bytes / baseline.bytes, incrementalGain: 1 - candidate.bytes / previous.bytes, cpuRatio: candidate.cpuMs / baseline.cpuMs};
    if (effort === 5 && quality < 100) {
      const proposal = complete(quantisationSteps(data, complete(photoCoefficientSteps(data, width, height, quality, 'srgb'))));
      if (proposal) {
        const selected = candidate.sha256 !== previous.sha256;
        row.reconstructionError = {baseline: proposal.reconstructionError.baseline, candidate: selected ? proposal.reconstructionError.candidate : proposal.reconstructionError.baseline, selected};
        assert.ok(row.reconstructionError.candidate <= row.reconstructionError.baseline, id + ': unclipped RGB sample error');
      }
    }
    if (native) {
      for (const result of [baseline, previous, candidate]) {
        const bytes = readFileSync(result.encoded), back = await native.decode(bytes, width, height);
        result.rgbSse = rgbSse(data, back);
        if (rust) {
          const others = [toRGBA(oxide(bytes)), rust.decode(bytes, width, height)];
          result.decoderDifferences = others.map(out => { rgbSse(data, out); return decoderDifference(out, back); });
          assert.ok(result.decoderDifferences.every(d => !d.alpha && d.maximum <= 1), id + ': decoder reconstruction differs by more than one RGB level');
        }
      }
      row.integerErrorRatio = candidate.rgbSse / Math.max(1, baseline.rgbSse);
    }
    delete baseline.encoded; delete previous.encoded; delete candidate.encoded;
    rows.push(row); console.log(JSON.stringify(row));
  }
} finally { if (native) await native.close(); }
assert.deepEqual(sourceHashes(), sources, 'encoder module graph changed during the run');
assert.equal(hash(readFileSync(self)), programHash, 'measurement program changed during the run');
const total = key => rows.reduce((sum, row) => sum + row[key].bytes, 0), cpu = key => rows.reduce((sum, row) => sum + row[key].cpuMs, 0);
const receipt = {node: process.version, source, quality, effort, previousEffort, repeat, start, count: inputs.length, runtime: 'isolated Node processes; host CPU, no throttle',
  machine: {platform: platform(), arch: arch(), cpu: cpus()[0]?.model},
  sources, programHash,
  model: 'The selector bounds edge-extended unclipped RGB sample AC reconstruction error before clipping and integer output; decoded byte RGB SSE is separately reported and may increase.',
  oracles: {native: native?.version || null, oxide: oxide?.version || null, rust: rust?.version || null},
  summary: {pictures: rows.length, baselineBytes: total('baseline'), previousBytes: total('previous'), candidateBytes: total('candidate'), gain: 1 - total('candidate') / total('baseline'), incrementalGain: 1 - total('candidate') / total('previous'),
    cpuRatio: cpu('candidate') / cpu('baseline'), incrementalCpuRatio: cpu('candidate') / cpu('previous'), baselinePeakRssKiB: Math.max(...rows.map(row => row.baseline.peakRssKiB)), candidatePeakRssKiB: Math.max(...rows.map(row => row.candidate.peakRssKiB)),
    integerErrorIncreases: native ? rows.filter(row => row.integerErrorRatio > 1).length : null}, rows};
if (args.output) writeFileSync(args.output, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt.summary));
