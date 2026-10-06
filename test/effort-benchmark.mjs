// SPDX-License-Identifier: MIT
// Measurement, never a timing gate. Input is a JSON array of {id, kind, width, height, pixels, rgbaHash}; pixels
// names raw straight RGBA. Each level runs in its own process, and decoder memory never enters its peak RSS.
// node test/effort-benchmark.mjs --input=/tmp/inputs.json --output=/tmp/effort.json --oracles=none
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir, cpus} from 'node:os';
import {join, resolve, dirname, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {encode} from '../src/effort.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(arg => { const [key, ...rest] = arg.replace(/^--/, '').split('='); return [key, rest.join('=') || true]; }));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const median = numbers => [...numbers].sort((a, b) => a - b)[numbers.length >> 1];
const sourceDirectory = fileURLToPath(new URL('../src/', import.meta.url));
function sourceGraph() {
  const files = new Map();
  const visit = file => {
    if (files.has(file)) return;
    const bytes = readFileSync(file), source = bytes.toString('utf8'); files.set(file, hash(bytes));
    for (const match of source.matchAll(/^(?:import|export)\s+[^;]*?\sfrom\s+['"]([^'"]+)['"]/gm)) {
      if (match[1].startsWith('.')) visit(resolve(dirname(file), match[1]));
    }
  };
  visit(join(sourceDirectory, 'effort.mjs'));
  files.set(fileURLToPath(import.meta.url), hash(readFileSync(fileURLToPath(import.meta.url))));
  return Object.fromEntries([...files].map(([file, sha256]) => [relative(sourceDirectory, file), sha256]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
const sourceGraphBefore = sourceGraph(), sourceGraphSha256 = hash(JSON.stringify(sourceGraphBefore));
const repeats = args.repeats === undefined ? 3 : Number(args.repeats);
assert.ok(Number.isSafeInteger(repeats) && repeats > 0, '--repeats is a positive integer');
const photoRepeats = args['photo-repeats'] === undefined ? repeats : Number(args['photo-repeats']);
assert.ok(Number.isSafeInteger(photoRepeats) && photoRepeats > 0, '--photo-repeats is a positive integer');
const allowSizeRefusals = args['allow-size-refusals'] === true || args['allow-size-refusals'] === 'true';

if (args.child) {
  const rgba = new Uint8Array(readFileSync(args.pixels)), width = Number(args.width), height = Number(args.height), effort = Number(args.effort);
  assert.equal(hash(rgba), args['rgba-hash'], 'the child received the pinned source bytes');
  const aliases = typeof args['alias-levels'] === 'string' ? String(args['alias-levels']).split(',').map(Number) : [];
  let warm;
  try { warm = encode(rgba, width, height, {effort}); }
  catch (error) {
    if (!allowSizeRefusals || error.code !== 'JXL_SIZE') throw error;
    for (const alias of aliases) assert.throws(() => encode(rgba, width, height, {effort: alias}), {code: 'JXL_SIZE'});
    assert.deepEqual(sourceGraph(), sourceGraphBefore, 'source files changed during the refusal');
    console.log(JSON.stringify({effort, refused: 'JXL_SIZE', aliases, sourceGraphSha256})); process.exit(0);
  }
  const reference = hash(warm), samples = [];
  for (let i = 0; i < repeats; i++) {
    const cpu = process.cpuUsage(), start = performance.now(), bytes = encode(rgba, width, height, {effort});
    const ms = performance.now() - start, used = process.cpuUsage(cpu);
    assert.equal(hash(bytes), reference, 'repeated calls must preserve every byte');
    samples.push({ms, cpuMs: (used.user + used.system) / 1000});
  }
  writeFileSync(args.encoded, warm);
  const peakRssKiB = process.platform === 'linux' ? Number(readFileSync('/proc/self/status', 'utf8').match(/^VmHWM:\s+(\d+)/m)[1]) : process.resourceUsage().maxRSS;
  for (const alias of aliases) assert.deepEqual(encode(rgba, width, height, {effort: alias}), warm, `effort ${alias} must alias ${effort}`);
  assert.deepEqual(sourceGraph(), sourceGraphBefore, 'source files changed during the measurement');
  console.log(JSON.stringify({effort, bytes: warm.length, sha256: reference, ms: median(samples.map(s => s.ms)), cpuMs: median(samples.map(s => s.cpuMs)), peakRssKiB, samples, aliases, sourceGraphSha256}));
  process.exit(0);
}

assert.ok(typeof args.input === 'string' && typeof args.output === 'string', '--input and --output are required');
const input = resolve(args.input), manifest = JSON.parse(readFileSync(input, 'utf8'));
assert.ok(Array.isArray(manifest) && manifest.length > 0, 'input is a nonempty JSON array');
assert.equal(new Set(manifest.map(row => row.id)).size, manifest.length, 'input IDs are unique');
if (args['expected-count']) assert.equal(manifest.length, Number(args['expected-count']), 'input slice has the expected size');
const levels = String(args.efforts || '1,3,4,5,6').split(',').map(Number);
assert.ok(levels.every(n => Number.isInteger(n) && n >= 1 && n <= 9), 'efforts are integers from 1 to 9');
assert.equal(new Set(levels).size, levels.length, 'efforts are unique');
if (allowSizeRefusals) assert.ok(levels.includes(1), 'size-refusal admission requires the effort-1 floor');
const aliases = Object.fromEntries(String(args.aliases || '').split(',').filter(Boolean).map(pair => {
  const values = pair.split(':').map(Number);
  assert.ok(values.length === 2 && values.every(n => Number.isInteger(n) && n >= 1 && n <= 9) && levels.includes(values[1]), '--aliases is a list of alias:measured effort pairs');
  return values;
}));
const proof = args.oracles || 'none';
assert.ok(['none', 'native', 'all'].includes(proof), '--oracles is none, native or all');
let native, rust, oxide, rgbaOf;
if (proof !== 'none') { const {nativeDecoder} = await import('./native-decoder.mjs'); native = await nativeDecoder(); }
if (proof === 'all') {
  const {decoder} = await import('./decoder.mjs'), {jxlRsDecoder} = await import('./jxl-rs-decoder.mjs');
  ({rgbaOf} = await import('./oracles.mjs'));
  oxide = await decoder(); rust = await jxlRsDecoder()?.persistent();
  assert.ok(oxide && rust, 'all three configured oracles are required');
}
const temporary = mkdtempSync(join(tmpdir(), 'jxl-effort-')), encoded = join(temporary, 'output.jxl'), rows = [];
const report = {runtime: process.version, platform: process.platform, machine: cpus()[0]?.model, timing: 'Node unthrottled; no CPU-4 or phone extrapolation', repeats, photoRepeats, inputSha256: hash(readFileSync(input)),
  aliases, aliasProof: 'Checked after timing and peak-memory sampling, with the measured stream as the byte reference',
  sourceGraphBefore, sourceGraphSha256, expectedRows: manifest.length, complete: false,
  allowSizeRefusals, counts: {expectedAttempts: manifest.length * levels.length, attempts: 0, returned: 0, refused: 0, oracleDecodes: 0},
  oracles: [native && `libjxl ${native.version}`, oxide && `jxl-oxide ${oxide.version}`, rust && `jxl-rs ${rust.version}`].filter(Boolean), levels, rows};
try {
  for (let index = 0; index < manifest.length; index++) {
    const item = manifest[index], pixels = resolve(dirname(input), item.pixels), rgba = new Uint8Array(readFileSync(pixels));
    assert.equal(rgba.length, item.width * item.height * 4, item.id + ': input length');
    assert.match(item.rgbaHash, /^[0-9a-f]{64}$/, item.id + ': a pinned source hash is required');
    const rgbaHash = hash(rgba); assert.equal(rgbaHash, item.rgbaHash, item.id + ': source bytes');
    const row = {id: item.id, kind: item.kind, width: item.width, height: item.height, seed: item.seed, rgbaHash, measurements: []};
    // Rotate the order across pictures; every level still starts with a fresh runtime and one untimed warmup.
    const order = levels.map((_, k) => levels[(k + index) % levels.length]);
    for (const effort of order) {
      const aliasLevels = Object.entries(aliases).filter(([, measured]) => measured === effort).map(([alias]) => alias).join(',');
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', `--pixels=${pixels}`, `--rgba-hash=${rgbaHash}`, `--width=${item.width}`, `--height=${item.height}`, `--effort=${effort}`, `--repeats=${item.kind === 'photo' ? photoRepeats : repeats}`, `--encoded=${encoded}`, `--alias-levels=${aliasLevels}`, ...(allowSizeRefusals ? ['--allow-size-refusals'] : [])], {encoding: 'utf8', maxBuffer: 65536});
      assert.ifError(child.error); assert.equal(child.status, 0, item.id + ': ' + child.stderr);
      const measured = JSON.parse(child.stdout);
      assert.equal(measured.sourceGraphSha256, sourceGraphSha256, item.id + ': the child measured the frozen source graph');
      row.measurements.push(measured);
      report.counts.attempts++;
      if (measured.refused) { assert.ok(allowSizeRefusals); assert.equal(measured.refused, 'JXL_SIZE'); report.counts.refused++; }
      else report.counts.returned++;
      if (!measured.refused && proof !== 'none') {
        const bytes = new Uint8Array(readFileSync(encoded));
        measured.decodedSha256 = hash(bytes); assert.equal(measured.decodedSha256, measured.sha256, 'the measured stream is the decoded stream');
        assert.deepEqual(await native.decode(bytes, item.width, item.height), rgba, item.id + ': native RGBA');
        if (proof === 'all') { assert.deepEqual(rgbaOf(oxide(bytes)), rgba, item.id + ': oxide RGBA'); assert.deepEqual(await rust.decode(bytes, item.width, item.height), rgba, item.id + ': rust RGBA'); }
        report.counts.oracleDecodes += proof === 'all' ? 3 : 1;
      }
    }
    row.measurements.sort((a, b) => a.effort - b.effort);
    row.status = row.measurements.some(measured => measured.refused) ? 'refused' : 'returned';
    if (row.status === 'refused') {
      assert.ok(row.measurements.every(measured => measured.refused === 'JXL_SIZE'), item.id + ': a refusal requires the effort-1 floor and every selected effort to refuse identically');
    } else for (let k = 1; k < row.measurements.length; k++) assert.ok(row.measurements[k].bytes <= row.measurements[k - 1].bytes, item.id + ': effort lost the smaller candidate');
    rows.push(row); writeFileSync(args.output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({id: row.id, completed: rows.length, total: manifest.length}));
  }
  assert.equal(hash(readFileSync(input)), report.inputSha256, 'input manifest changed during the run');
  report.inputHashesAfter = Object.fromEntries(manifest.map(item => {
    const sha256 = hash(readFileSync(resolve(dirname(input), item.pixels)));
    assert.equal(sha256, item.rgbaHash, item.id + ': input changed during the run'); return [item.id, sha256];
  }));
  report.sourceGraphAfter = sourceGraph(); assert.deepEqual(report.sourceGraphAfter, sourceGraphBefore, 'source files changed during the run');
  report.complete = true; writeFileSync(args.output, JSON.stringify(report, null, 2) + '\n');
} finally { await native?.close(); await rust?.close(); rmSync(temporary, {recursive: true, force: true}); }
