// SPDX-License-Identifier: MIT
// Measurement only, never a timing gate. Take the shared browser lock before a real run.
// --plan validates the selected manifest bytes and source snapshot without loading Playwright.
// Example: RAPIER_WITNESS_LOCKED=1 node public/test/rung-browser-benchmark.mjs \
//   --inputs=inputs.json --door=jpeg --efforts=1,4 --start=0 --count=20 --rounds=3 --out=cpu4-jpeg
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, realpath} from 'node:fs/promises';
import {createServer} from 'node:http';
import {resolve, relative, dirname, extname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {cpus, platform, arch} from 'node:os';

const args = Object.create(null), known = new Set(['inputs', 'root', 'door', 'efforts', 'quality', 'start', 'count', 'rounds', 'out', 'plan', 'help']);
for (let at = 2; at < process.argv.length; at++) {
  const match = /^--([a-z]+)(?:=(.*))?$/.exec(process.argv[at]);
  assert(match && known.has(match[1]), 'Unknown argument: ' + process.argv[at]);
  const [, key, inline] = match;
  assert(!(key in args), 'Duplicate argument: --' + key);
  if (key === 'plan' || key === 'help') { assert(inline === undefined, '--' + key + ' takes no value'); args[key] = true; }
  else {
    const value = inline ?? process.argv[++at];
    assert(value && !value.startsWith('--'), '--' + key + ' needs a value'); args[key] = value;
  }
}
if (args.help) {
  console.log('node public/test/rung-browser-benchmark.mjs --inputs=inputs.json --door=jpeg|photo|effort --efforts=1,4 --start=0 --count=N --rounds=3 --out=directory [--root=encoder-directory] [--quality=90] [--plan]\nManifest: array of {id,width,height,file,sha256,pixels,rgbaHash}; relative files resolve beside the manifest. JPEG uses file/sha256, pixel doors use pixels/rgbaHash. A real run requires RAPIER_WITNESS_LOCKED=1 under the shared browser lock.');
  process.exit(0);
}
assert(args.inputs, '--inputs is required');
const door = args.door || 'jpeg';
assert(['jpeg', 'photo', 'effort'].includes(door), '--door must be jpeg, photo or effort');
const integer = (value, label, min) => { const n = Number(value); assert(Number.isSafeInteger(n) && n >= min, label + ' must be a whole number >= ' + min); return n; };
const efforts = (args.efforts || (door === 'effort' ? '1,2,3' : '1,4')).split(',').map(value => {
  assert(/^[1-9]$/.test(value), '--efforts requires whole numbers from 1 to 9'); return Number(value);
});
assert.equal(new Set(efforts).size, efforts.length, '--efforts contains a duplicate');
assert(door !== 'jpeg' || args.quality === undefined, 'The JPEG door does not take --quality');
const quality = door === 'jpeg' ? null : Number(args.quality ?? (door === 'photo' ? 90 : 100));
assert(quality === null || Number.isFinite(quality) && quality >= 1 && quality <= 100, '--quality must be from 1 to 100');
const rounds = integer(args.rounds ?? 3, '--rounds', 1), start = integer(args.start ?? 0, '--start', 0);
if (!args.plan) assert.equal(process.env.RAPIER_WITNESS_LOCKED, '1', 'Take the shared browser lock and set RAPIER_WITNESS_LOCKED=1 before browser measurement');
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), digestPattern = /^[0-9a-f]{64}$/;
const root = await realpath(resolve(args.root || fileURLToPath(new URL('../../', import.meta.url))));
const manifestFile = resolve(args.inputs), manifestBytes = await readFile(manifestFile), manifest = JSON.parse(manifestBytes);
assert(Array.isArray(manifest) && manifest.length, '--inputs must contain a nonempty array');
const count = integer(args.count ?? manifest.length - start, '--count', 1);
assert(start + count <= manifest.length, 'The requested input slice is outside the manifest');
assert.equal(new Set(manifest.map(row => row.id)).size, manifest.length, 'Manifest IDs must be unique');
const out = resolve(args.out || 'dist/jxl-rung-browser-' + door), entry = door + '.mjs';

// Only the entry's relative static-module graph is served, from immutable buffers read before timing.
// Canonical paths reject symlinks outside the encoder directory; requests never become filesystem paths.
const modules = new Map();
async function snapshotModule(file) {
  const canonical = await realpath(file), name = relative(root, canonical);
  assert(name && !name.startsWith('..' + sep) && name !== '..' && !name.startsWith(sep) && extname(name) === '.mjs', 'Module escaped encoder root: ' + file);
  if (modules.has(canonical)) return;
  const bytes = await readFile(canonical), source = bytes.toString('utf8');
  assert(!/\bimport\s*\(/.test(source), 'Dynamic import needs an explicit snapshot entry: ' + name);
  const url = '/modules/' + name.split(sep).map(encodeURIComponent).join('/');
  modules.set(canonical, {name: name.split(sep).join('/'), url, bytes, sha256: hash(bytes)});
  for (const match of source.matchAll(/\b(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
    assert(/^\.{1,2}\//.test(match[1]) && !/[?#]/.test(match[1]), 'Only local static encoder imports are allowed: ' + match[1]);
    await snapshotModule(resolve(dirname(canonical), match[1]));
  }
}
await snapshotModule(resolve(root, entry));
const sourceHashes = Object.fromEntries([...modules.values()].sort((a, b) => a.name.localeCompare(b.name)).map(module => [module.name, module.sha256]));
const moduleRoutes = new Map([...modules.values()].map(module => [module.url, module]));
const inputs = [], inputRoutes = new Map();
async function loadInput(input) {
  const bytes = await readFile(input.file);
  assert.equal(hash(bytes), input.sha256, input.id + ': input bytes changed');
  if (door !== 'jpeg') assert.equal(bytes.length, input.width * input.height * 4, input.id + ': RGBA size does not match dimensions');
  else assert(bytes[0] === 0xff && bytes[1] === 0xd8, input.id + ': input is not a JPEG');
  return bytes;
}
for (let index = start; index < start + count; index++) {
  const row = manifest[index];
  assert(typeof row.id === 'string' && row.id, 'Every selected input needs an ID');
  const width = integer(row.width, row.id + ': width', 1), height = integer(row.height, row.id + ': height', 1);
  assert(Number.isSafeInteger(width * height * 4), row.id + ': dimensions overflow');
  const file = door === 'jpeg' ? row.file : row.pixels, sha256 = door === 'jpeg' ? row.sha256 : row.rgbaHash;
  assert(typeof file === 'string' && file && digestPattern.test(sha256), row.id + ': missing file or SHA256 for this door');
  const input = {index, id: row.id, kind: row.kind ?? 'photo', size: row.size ?? 'photo', seed: row.seed, width, height,
    file: await realpath(resolve(dirname(manifestFile), file)), sha256, generationSourceSha256: row.sourceHash, url: '/inputs/' + index};
  input.inputBytes = (await loadInput(input)).length;
  inputs.push(input); inputRoutes.set(input.url, input);
}
const receipt = {status: args.plan ? 'PLANNED' : 'RUNNING', browserMeasurementsRun: false, startedAt: new Date().toISOString(),
  mode: 'browser-CDP-4x-main-page', requestedCPUThrottlingRate: 4, door, quality, efforts, rounds, warmupPerInputEffort: 1,
  timing: 'performance.now wall time around the synchronous public door only; main page, no worker; fetch, import, input copy and SHA256 outside timing; per-input medians summed in totals',
  proof: 'Stream hashes must repeat after warm-up; independent decoder correctness is a separate receipt',
  ordering: 'Effort order reversed on alternating rounds and alternating inputs', node: process.version, host: {platform: platform(), arch: arch(), cpu: cpus()[0]?.model},
  encoderRoot: root, entry, sourceHashes, sourceSnapshotSha256: hash(JSON.stringify(sourceHashes)), benchmarkSha256: hash(await readFile(fileURLToPath(import.meta.url))),
  inputManifest: manifestFile, inputManifestSha256: hash(manifestBytes), start, count, plannedTimedEncodes: count * efforts.length * rounds,
  plannedWarmupEncodes: count * efforts.length, inputs, rows: []};
await mkdir(out, {recursive: true});
if (args.plan) {
  const {rows, ...plan} = receipt;
  await writeFile(resolve(out, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  console.log(JSON.stringify({status: plan.status, browserMeasurementsRun: false, inputs: count, efforts, plannedTimedEncodes: plan.plannedTimedEncodes, sourceSnapshotSha256: plan.sourceSnapshotSha256, out}));
  process.exit(0);
}
const save = async () => {
  const journal = gzipSync(receipt.rows.map(row => JSON.stringify(row) + '\n').join(''));
  await writeFile(resolve(out, 'rows.jsonl.gz'), journal);
  const {rows, inputs: selected, ...summary} = receipt;
  await writeFile(resolve(out, 'summary.json'), JSON.stringify({...summary, completed: rows.length, rows: {file: 'rows.jsonl.gz', sha256: hash(journal)}}, null, 2) + '\n');
};
let browser, server;
const resourceErrors = [];
try {
  const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  server = createServer(async (request, response) => {
    try {
      if (request.method !== 'GET') { response.writeHead(405).end(); return; }
      response.setHeader('Cache-Control', 'no-store');
      if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; worker-src 'none'");
        response.end('<!doctype html><meta charset="utf-8"><title>Encoder rung measurement</title>'); return;
      }
      const module = moduleRoutes.get(request.url);
      if (module) { response.setHeader('Content-Type', 'text/javascript'); response.end(module.bytes); return; }
      const input = inputRoutes.get(request.url);
      if (input) { const bytes = await loadInput(input); response.setHeader('Content-Type', 'application/octet-stream'); response.end(bytes); return; }
      response.writeHead(404).end();
    } catch (error) { resourceErrors.push(String(error)); response.writeHead(500).end(); }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  browser = await playwright.chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH} : {})});
  const page = await browser.newPage(), session = await page.context().newCDPSession(page);
  await page.goto('http://127.0.0.1:' + server.address().port);
  await session.send('Emulation.setCPUThrottlingRate', {rate: 4});
  receipt.browser = browser.version(); receipt.cpuThrottlingRate = 4;
  receipt.userAgent = await page.evaluate(() => navigator.userAgent);
  await save();
  for (const input of inputs) {
    const result = await page.evaluate(async ({input, entry, door, quality, efforts, rounds}) => {
      if (globalThis !== window) throw new Error('Measurement must run on the main page');
      const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
      const fetched = await fetch(input.url, {cache: 'no-store'});
      if (!fetched.ok) throw new Error(input.id + ': input fetch failed');
      const original = new Uint8Array(await fetched.arrayBuffer()), module = await import('/modules/' + entry);
      if (await hash(original) !== input.sha256) throw new Error(input.id + ': fetched input SHA256 differs');
      const records = new Map(), roundOrders = [];
      const encode = door === 'jpeg' ? (data, effort) => module.transcode(data, {effort}) : door === 'photo'
        ? (data, effort) => module.encodePhoto(data, input.width, input.height, {effort, quality})
        : (data, effort) => module.encode(data, input.width, input.height, {effort, quality});
      const run = async (effort, timed) => {
        const data = original.slice(); // Copy before the clock; every encode receives the same immutable source bytes.
        const from = timed ? performance.now() : 0;
        const encoded = encode(data, effort);
        const wallMs = timed ? performance.now() - from : null;
        const bytes = door === 'jpeg' ? encoded.bytes : encoded;
        if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('Public door returned no stream');
        const sha256 = await hash(bytes), shown = door === 'jpeg' ? {width: encoded.width, height: encoded.height, orientation: encoded.orientation} : {width: input.width, height: input.height};
        let record = records.get(effort);
        if (!record) { record = {effort, bytes: bytes.length, sha256, ...shown, wallSamplesMs: []}; records.set(effort, record); }
        else if (sha256 !== record.sha256 || bytes.length !== record.bytes || shown.width !== record.width || shown.height !== record.height || shown.orientation !== record.orientation) throw new Error(input.id + ': effort ' + effort + ' did not repeat its warm-up stream');
        if (timed) record.wallSamplesMs.push(wallMs);
      };
      for (const effort of efforts) await run(effort, false);
      for (let round = 0; round < rounds; round++) {
        const order = (round + input.index) & 1 ? [...efforts].reverse() : [...efforts]; roundOrders.push(order);
        for (const effort of order) await run(effort, true);
      }
      if (await hash(original) !== input.sha256) throw new Error('The retained input was mutated');
      const median = values => { const ordered = [...values].sort((a, b) => a - b), middle = ordered.length >> 1; return ordered.length & 1 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2; };
      return {roundOrders, measurements: efforts.map(effort => { const record = records.get(effort); return {...record, medianWallMs: median(record.wallSamplesMs)}; })};
    }, {input, entry, door, quality, efforts, rounds});
    assert.equal(resourceErrors.length, 0, resourceErrors.join('\n'));
    const {url, ...provenance} = input;
    receipt.rows.push({...provenance, ...result}); receipt.browserMeasurementsRun = true;
    await save(); console.log(JSON.stringify({done: receipt.rows.length, id: input.id, measurements: result.measurements.map(({effort, bytes, medianWallMs}) => ({effort, bytes, medianWallMs}))}));
  }
  assert.equal(receipt.rows.length, count);
  for (const [file, module] of modules) assert.equal(hash(await readFile(file)), module.sha256, 'Source changed during measurement: ' + module.name);
  assert.equal(hash(await readFile(manifestFile)), receipt.inputManifestSha256, 'Input manifest changed during measurement');
  for (const input of inputs) await loadInput(input);
  receipt.totals = efforts.map(effort => {
    const values = receipt.rows.map(row => row.measurements.find(value => value.effort === effort));
    return {effort, inputs: values.length, bytes: values.reduce((sum, value) => sum + value.bytes, 0), summedMedianWallMs: values.reduce((sum, value) => sum + value.medianWallMs, 0), timedEncodes: values.length * rounds};
  });
  const baseline = receipt.totals.find(value => value.effort === 1);
  if (baseline) for (const total of receipt.totals) { total.byteGainPercent = 100 * (1 - total.bytes / baseline.bytes); total.wallRatioToEffort1 = total.summedMedianWallMs / baseline.summedMedianWallMs; }
  receipt.status = 'PASS'; receipt.finishedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({status: receipt.status, browserMeasurementsRun: true, cpuThrottlingRate: 4, totals: receipt.totals, out}));
} catch (error) {
  receipt.status = 'FAIL'; receipt.error = String(error); receipt.finishedAt = new Date().toISOString(); await save();
  console.error(receipt.error); process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server?.listening) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
