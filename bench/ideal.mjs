#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Complete API measurements, independent decoders, and measured perceptual-quality matching. See IDEAL.md.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {cpus, release, endianness} from 'node:os';
import {dirname, join, resolve, relative} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {Worker} from 'node:worker_threads';
import {readIdealPng} from './ideal-corpus.mjs';
import {sha256, writePng} from './image-io.mjs';

const run = promisify(execFile), here = dirname(fileURLToPath(import.meta.url));
const median = values => { const a = [...values].sort((a, b) => a - b), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const args = {runtime: 'node', label: 'candidate', workers: 0, efforts: [1, 3, 7, 9], qualities: [60, 75, 85, 90, 95],
  distances: [.25, .5, 1, 2, 4, 8, 16, 25], modes: ['lossy', 'lossless'], warmups: 1, repeats: 3, matchSteps: 7};
const list = value => value.split(',').filter(Boolean);
for (let i = 2; i < process.argv.length; i++) {
  const name = process.argv[i].replace(/^--/, ''), value = process.argv[++i];
  assert(value && !value.startsWith('--'), '--' + name + ' requires a value');
  if (['efforts', 'qualities', 'distances'].includes(name)) args[name] = list(value).map(Number);
  else if (['ids', 'modes'].includes(name)) args[name] = list(value);
  else if (['workers', 'warmups', 'repeats', 'matchSteps'].includes(name)) args[name] = Number(value);
  else if (['corpus', 'out', 'encoder', 'tools', 'oxide', 'chrome', 'playwright', 'match', 'label', 'runtime', 'options'].includes(name)) args[name] = value;
  else throw new Error('Unknown argument: --' + name);
}
for (const key of ['corpus', 'out', 'tools', 'oxide']) assert(args[key], 'Missing --' + key);
assert(['node', 'chrome', 'libjxl'].includes(args.runtime), 'Choose node, chrome or libjxl');
assert([0, 3].includes(args.workers), '--workers is 0 or 3 (coordinator plus up to three helpers)');
assert(Number.isInteger(args.warmups) && args.warmups >= 0 && Number.isInteger(args.repeats) && args.repeats > 0);
assert(args.efforts.every(x => Number.isInteger(x) && x >= 1 && x <= 9));
assert(args.qualities.every(x => Number.isFinite(x) && x >= 1 && x < 100));
assert(args.distances.every(x => Number.isFinite(x) && x > 0 && x <= 25));
assert(args.modes.every(x => ['lossy', 'lossless'].includes(x)));
assert.equal(process.version, 'v22.23.3', 'Use pinned Node 22.23.3');
assert.equal(endianness(), 'LE', 'The raw HDR fixture is little-endian');
for (const key of ['corpus', 'out', 'tools', 'oxide', 'encoder', 'chrome', 'playwright', 'match', 'options']) if (args[key]) args[key] = resolve(args[key]);
const extraOptions = args.options ? JSON.parse(readFileSync(args.options, 'utf8')) : {};
assert(extraOptions && typeof extraOptions === 'object' && !Array.isArray(extraOptions), '--options must name a JSON object');
for (const name of ['quality', 'effort', 'photo', 'lossless', 'parallel', 'bitDepth', 'sampleFormat', 'colorSpace', 'transferFunction', 'intensityTarget'])
  assert(!(name in extraOptions), '--options cannot override a matrix or source descriptor field: ' + name);
mkdirSync(args.out, {recursive: true});
for (const name of ['jxl', 'decoded', 'references']) mkdirSync(join(args.out, name), {recursive: true});
const manifestBytes = readFileSync(join(args.corpus, 'manifest.json')), manifest = JSON.parse(manifestBytes);
const inputs = manifest.filter(row => !args.ids || args.ids.includes(row.id));
assert(inputs.length && (!args.ids || inputs.length === new Set(args.ids).size), 'No input or unknown input IDs');
const tools = Object.fromEntries(['cjxl', 'djxl', 'ssimulacra2', 'butteraugli_main'].map(name => [name, join(args.tools, name)]));
const versions = {};
for (const [name, path] of [['cjxl', tools.cjxl], ['djxl', tools.djxl], ['oxide', args.oxide]]) {
  const r = await run(path, ['--version'], {timeout: 30000});
  versions[name] = (r.stdout + r.stderr).trim().split('\n')[0];
  assert(versions[name].includes(name === 'oxide' ? '0.12.6' : '0.12.0'), 'Unexpected decoder/tool version: ' + versions[name]);
}
const toolHashes = Object.fromEntries([...Object.entries(tools), ['oxide', args.oxide]].map(([name, file]) => [name, sha256(readFileSync(file))]));
const harnessBytes = Object.fromEntries(['ideal.mjs', 'ideal-runtime.mjs', 'ideal-corpus.mjs', 'ideal-corpus-sources.json', 'image-io.mjs'].map(name => [name, readFileSync(join(here, name))]));
const harnessFiles = Object.fromEntries(Object.entries(harnessBytes).map(([name, bytes]) => [name, sha256(bytes)]));
const harnessHash = sha256(JSON.stringify(harnessFiles)), harnessSnapshot = join(args.out, 'protocol', harnessHash);
mkdirSync(harnessSnapshot, {recursive: true});
for (const [name, bytes] of Object.entries(harnessBytes)) writeFileSync(join(harnessSnapshot, name), bytes);

// Snapshot every local module reached by the complete encoder. Both runtimes import only these fixed bytes.
let sourceHash = null, snapshot, sourceFiles = {}, sourceRoutes = new Map();
if (args.runtime !== 'libjxl') {
  assert(args.encoder, 'Missing --encoder DIRECTORY');
  const collected = new Map();
  function visit(file) {
    const name = relative(args.encoder, file).replaceAll('\\', '/');
    assert(!name.startsWith('../') && name.endsWith('.mjs'), 'Encoder import outside source root: ' + name);
    if (collected.has(name)) return;
    const bytes = readFileSync(file); collected.set(name, bytes);
    for (const match of bytes.toString().matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.[^"']+)["']/g)) visit(resolve(dirname(file), match[1]));
  }
  visit(join(args.encoder, 'rapier.mjs'));
  sourceFiles = Object.fromEntries([...collected].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => [name, sha256(bytes)]));
  sourceHash = sha256(JSON.stringify(sourceFiles)); snapshot = join(args.out, 'snapshots', sourceHash); mkdirSync(snapshot, {recursive: true});
  for (const [name, bytes] of collected) {
    assert.equal(sha256(readFileSync(join(args.encoder, name))), sourceFiles[name], 'Source changed during snapshot');
    const target = join(snapshot, name); mkdirSync(dirname(target), {recursive: true}); writeFileSync(target, bytes);
    sourceRoutes.set('/modules/' + name, bytes);
  }
}
const identity = {protocol: 1, runtime: args.runtime, sourceHash, corpusHash: sha256(manifestBytes), node: process.version,
  workersRequested: args.workers, toolHashes, harnessHash, harnessFiles, extraOptions};
const identityHash = sha256(JSON.stringify(identity));
const resultsFile = join(args.out, 'results.jsonl'), rows = existsSync(resultsFile) ? readFileSync(resultsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const done = new Map(rows.map(row => [row.key, row]));
const record = row => { appendFileSync(resultsFile, JSON.stringify(row) + '\n'); rows.push(row); done.set(row.key, row); };
appendFileSync(join(args.out, 'plans.jsonl'), JSON.stringify({at: new Date().toISOString(), identityHash, args}) + '\n');
const environment = {...identity, identityHash, versions, label: args.label, encoder: args.encoder, sourceFiles, platform: process.platform,
  arch: process.arch, release: release(), cpu: cpus()[0]?.model, affinity: readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1],
  timing: args.runtime === 'libjxl' ? 'Each cjxl process uses num_reps=1. reportedEncodeMs comes from its printed rounded MP/s; processWallMs includes launch, PNG read and output write. Separate warmups precede repeats.' :
    'performance.now around await complete createEncoder.encode in a persistent coordinator Worker; input loading/copy, hashing, decoding and metric work excluded. New helper startup and all internal coordination included.'};

let runner, browser, server;
const savedResponses = new Map();
async function nodeRunner() {
  const started = performance.now(), thread = new Worker(pathToFileURL(join(harnessSnapshot, 'ideal-runtime.mjs')), {type: 'module'}), pending = new Map(); let serial = 0;
  thread.on('message', message => {
    const request = pending.get(message.requestId); if (!request) return;
    pending.delete(message.requestId); clearTimeout(request.timer);
    message.failed ? request.reject(new Error(JSON.stringify(message.failed))) : request.resolve(message);
  });
  thread.on('error', error => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); } pending.clear(); });
  const call = (message, transfer = []) => new Promise((resolve, reject) => {
    const requestId = ++serial, timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Encoder command timed out')); }, 900000);
    pending.set(requestId, {resolve, reject, timer}); thread.postMessage({...message, requestId}, transfer);
  });
  const initialized = await call({kind: 'init', root: pathToFileURL(snapshot).href, helpers: args.workers});
  environment.startup = {ms: performance.now() - started, importMs: initialized.importMs};
  return {call, close: () => thread.terminate()};
}
async function chromeRunner() {
  assert(args.chrome, 'Missing --chrome PATH');
  const routeInputs = new Map(manifest.map(row => ['/inputs/' + row.id, join(args.corpus, row.pixels)]));
  server = createServer(async (request, response) => {
    try {
      if (request.method === 'POST' && /^\/result\/[0-9]+$/.test(request.url)) {
        const parts = []; for await (const part of request) parts.push(part);
        savedResponses.set(request.url, Buffer.concat(parts)); response.end('ok'); return;
      }
      if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>JPEG XL measurement</title>'); return; }
      if (request.url === '/ideal-runtime.mjs') { response.setHeader('Content-Type', 'text/javascript'); response.end(harnessBytes['ideal-runtime.mjs']); return; }
      if (sourceRoutes.has(request.url)) { response.setHeader('Content-Type', 'text/javascript'); response.end(sourceRoutes.get(request.url)); return; }
      if (routeInputs.has(request.url)) { response.end(readFileSync(routeInputs.get(request.url))); return; }
      response.writeHead(404).end();
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const playwright = await import(args.playwright ? pathToFileURL(args.playwright).href : process.env.RAPIER_PLAYWRIGHT_MODULE || 'playwright');
  browser = await playwright.chromium.launch({executablePath: args.chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']});
  assert.equal(browser.version(), '155.0.8059.39', 'Use pinned Chrome 155.0.8059.39'); environment.chrome = browser.version();
  const page = await browser.newPage(); await page.goto(origin);
  const started = performance.now();
  await page.evaluate(() => {
    const worker = new Worker('/ideal-runtime.mjs', {type: 'module'}), pending = new Map(); let serial = 0;
    worker.onmessage = ({data}) => { const r = pending.get(data.requestId); if (r) { pending.delete(data.requestId); data.failed ? r.reject(new Error(JSON.stringify(data.failed))) : r.resolve(data); } };
    worker.onerror = error => { for (const r of pending.values()) r.reject(new Error(error.message)); pending.clear(); };
    globalThis.benchCall = async message => {
      const requestId = ++serial;
      if (message.kind === 'input') message.buffer = await (await fetch('/inputs/' + message.descriptor.id)).arrayBuffer();
      const result = await new Promise((resolve, reject) => { pending.set(requestId, {resolve, reject}); worker.postMessage({...message, requestId}, message.buffer ? [message.buffer] : []); });
      if (result.bytes) { const output = '/result/' + requestId; await fetch(output, {method: 'POST', body: result.bytes}); delete result.bytes; result.output = output; }
      return result;
    };
  });
  const initialized = await page.evaluate(message => globalThis.benchCall(message), {kind: 'init', root: origin + '/modules', helpers: args.workers});
  environment.startup = {ms: performance.now() - started, importMs: initialized.importMs};
  return {call: async message => {
    const result = await page.evaluate(message => globalThis.benchCall(message), message);
    if (result.output) { result.bytes = savedResponses.get(result.output); savedResponses.delete(result.output); }
    return result;
  }, close: async () => { await browser.close(); browser = null; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null; }};
}

function loadImage(entry) {
  const raw = readFileSync(join(args.corpus, entry.pixels)); assert.equal(sha256(raw), entry.rgbaHash, 'Input hash differs: ' + entry.id);
  const data = entry.bitDepth === 16 ? new Uint16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length)) : new Uint8Array(raw);
  assert.equal(data.length, entry.width * entry.height * 4);
  return {...entry, data};
}
function difference(a, b) {
  assert.equal(b.width, a.width); assert.equal(b.height, a.height); assert.equal(b.rgba.length, a.data.length);
  let changed = 0, maxRgb = 0, alphaChanged = 0, hiddenChanged = 0;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.rgba[i]) {
    changed++; if (i % 4 === 3) alphaChanged++;
    else { maxRgb = Math.max(maxRgb, Math.abs(a.data[i] - b.rgba[i])); if (a.data[i - i % 4 + 3] === 0) hiddenChanged++; }
  }
  return {changedSamples: changed, maxRgbDifference: maxRgb, alphaChangedSamples: alphaChanged, hiddenChangedSamples: hiddenChanged};
}
const linear = Float64Array.from({length: 256}, (_, i) => { const x = i / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; });
function composite(data, background) {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    for (let c = 0; c < 3; c++) { const value = linear[data[i + c]] * alpha + background * (1 - alpha); out[i + c] = Math.round(255 * (value <= .0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - .055)); }
    out[i + 3] = 255;
  }
  return out;
}
async function score(reference, decoded) {
  const result = {};
  for (const [name, tool] of [['ssimulacra2', tools.ssimulacra2], ['butteraugli', tools.butteraugli_main]]) {
    const r = await run(tool, [reference, decoded], {timeout: 180000, maxBuffer: 1 << 20});
    const value = Number.parseFloat(r.stdout); assert(Number.isFinite(value), 'Metric returned no finite number: ' + name); result[name] = value;
  }
  return result;
}
async function judge(row, image, file) {
  const decodes = {}, decoded = {};
  for (const name of ['djxl', 'oxide']) {
    const png = join(args.out, 'decoded', row.key.slice(0, 24) + '-' + name + '.png');
    const argv = name === 'djxl' ? [file, png, '--num_threads=0', '--bits_per_sample=' + image.bitDepth] : [file, '-o', png, '-f', image.bitDepth === 16 ? 'png16' : 'png8', '-j', '1'];
    const started = performance.now(); await run(name === 'djxl' ? tools.djxl : args.oxide, argv, {timeout: 300000, maxBuffer: 1 << 22});
    const result = readIdealPng(readFileSync(png)), diff = difference(image, result); decoded[name] = {...result, png};
    decodes[name] = {decoded: true, ms: performance.now() - started, ...diff};
    assert.equal(diff.alphaChangedSamples, 0, name + ' changed alpha');
    if (row.mode === 'lossless') assert.equal(diff.changedSamples, 0, name + ' changed lossless samples');
  }
  let between = 0;
  for (let i = 0; i < decoded.djxl.rgba.length; i++) between = Math.max(between, Math.abs(decoded.djxl.rgba[i] - decoded.oxide.rgba[i]));
  assert(between <= (row.mode === 'lossless' ? 0 : 1), 'Independent decoder samples differ beyond rounding');
  const judged = {decodes, maxDecoderDifference: between, exact: decodes.djxl.changedSamples === 0 && decodes.oxide.changedSamples === 0};
  if (row.mode === 'lossless' || image.bitDepth !== 8) return judged;
  const opaque = image.data.every((value, i) => i % 4 !== 3 || value === 255);
  if (opaque) judged.metrics = await score(join(args.corpus, image.png), decoded.djxl.png);
  else {
    const backgrounds = {};
    for (const [name, value] of [['black', 0], ['white', 1]]) {
      const source = join(args.out, 'references', image.id + '-' + name + '.png'), target = join(args.out, 'decoded', row.key.slice(0, 24) + '-' + name + '.png');
      if (!existsSync(source)) writeFileSync(source, writePng(image.width, image.height, composite(image.data, value)));
      writeFileSync(target, writePng(image.width, image.height, composite(decoded.djxl.rgba, value)));
      backgrounds[name] = await score(source, target);
    }
    judged.metrics = {ssimulacra2: Math.min(backgrounds.black.ssimulacra2, backgrounds.white.ssimulacra2),
      butteraugli: Math.max(backgrounds.black.butteraugli, backgrounds.white.butteraugli), backgrounds,
      composition: 'straight alpha composited in linear sRGB over black and white, converted back to sRGB8; worst score of the two backgrounds'};
  }
  return judged;
}
function rowBase(image, settings) {
  const key = sha256(JSON.stringify({identityHash, id: image.id, ...settings, warmups: args.warmups, repeats: args.repeats}));
  return {key, identityHash, sourceHash, label: args.label, runtime: args.runtime, workersRequested: args.workers,
    image: image.id, group: image.group, width: image.width, height: image.height, bitDepth: image.bitDepth,
    inputHash: image.rgbaHash, startedAt: new Date().toISOString(), ...settings};
}
async function finish(row, image, bytes) {
  Object.assign(row, {bytes: bytes.length, sha256: sha256(bytes), bpp: bytes.length * 8 / (image.width * image.height)});
  const file = join(args.out, 'jxl', row.key.slice(0, 24) + '.jxl'); writeFileSync(file, bytes); row.encoded = relative(args.out, file);
  Object.assign(row, await judge(row, image, file)); record(row);
  console.log(JSON.stringify({runtime: row.runtime, image: row.image, mode: row.mode, effort: row.effort, quality: row.quality, distance: row.distance,
    bytes: row.bytes, msPerMP: row.msPerMP, workersStarted: row.workersStarted, metrics: row.metrics}));
  return row;
}
async function measureRapier(image, settings) {
  const row = rowBase(image, settings); if (done.has(row.key)) return done.get(row.key);
  const options = {quality: settings.quality ?? 100, effort: settings.effort, photo: image.group.startsWith('photo'), lossless: settings.mode === 'lossless',
    bitDepth: image.bitDepth, sampleFormat: 'uint', colorSpace: image.colorSpace, transferFunction: image.transferFunction, intensityTarget: image.intensityTarget, ...extraOptions};
  const result = await runner.call({kind: 'measure', options, warmups: args.warmups, repeats: args.repeats});
  assert.equal(result.inputHash, image.rgbaHash, 'Encoder mutated retained input');
  Object.assign(row, {options, samples: result.samples, warmupSamples: result.warmupSamples, kernelMode: result.kernelMode,
    workersStarted: result.workersStarted, workerErrors: result.workerErrors, workerTasks: result.workerTasks,
    peakHelpers: result.peakHelpers,
    ms: median(result.samples.map(x => x.ms)), ...(args.runtime === 'node' ? {cpuMs: median(result.samples.map(x => x.cpuMs))} : {})});
  row.msPerMP = row.ms * 1e6 / (image.width * image.height);
  return finish(row, image, result.bytes);
}
async function measureLibjxl(image, settings) {
  const row = rowBase(image, settings); if (done.has(row.key)) return done.get(row.key);
  const file = join(args.out, 'jxl', row.key.slice(0, 24) + '.jxl'), samples = [], warmupSamples = [];
  const argv = [join(args.corpus, image.png), file, '-d', String(settings.distance ?? 0), '-e', String(settings.effort),
    '--num_threads=' + (args.workers ? 4 : 0), '--num_reps=1', '--alpha_distance=0', '--keep_invisible=1'];
  let expected;
  for (let i = 0; i < args.warmups + args.repeats; i++) {
    const start = performance.now(), result = await run(tools.cjxl, argv, {timeout: 900000, maxBuffer: 1 << 22});
    const wall = performance.now() - start, match = /([0-9.]+) MP\/s,/.exec(result.stderr + result.stdout);
    assert(match && Number(match[1]) > 0, 'cjxl did not report encode throughput');
    const bytes = readFileSync(file), digest = sha256(bytes); expected ??= digest; assert.equal(digest, expected, 'cjxl output did not repeat');
    const sample = {reportedEncodeMs: image.width * image.height / 1000 / Number(match[1]), processWallMs: wall, reportedMPs: Number(match[1])};
    (i < args.warmups ? warmupSamples : samples).push(sample);
  }
  Object.assign(row, {command: argv, samples, warmupSamples, ms: median(samples.map(x => x.reportedEncodeMs)),
    processWallMs: median(samples.map(x => x.processWallMs)), timing: 'reported rounded encode throughput, not process wall time', libjxlWorkerThreads: args.workers ? 4 : 0});
  row.msPerMP = row.ms * 1e6 / (image.width * image.height);
  return finish(row, image, readFileSync(file));
}

async function matchQuality(image, references) {
  const output = join(args.out, 'matches.jsonl');
  const existing = existsSync(output) ? new Set(readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).key)) : new Set();
  const compact = row => ({key: row.key, sourceHash: row.sourceHash, runtime: row.runtime, label: row.label, workersRequested: row.workersRequested,
    effort: row.effort, quality: row.quality, distance: row.distance, bytes: row.bytes, msPerMP: row.msPerMP, metrics: row.metrics});
  for (const reference of references) for (const effort of args.efforts) {
    assert.equal(reference.inputHash, image.rgbaHash, 'Quality-match reference has different source pixels');
    for (const metric of ['ssimulacra2', 'butteraugli']) assert(Number.isFinite(reference.metrics[metric]), 'Quality-match reference has no finite ' + metric);
    const key = sha256(JSON.stringify([identityHash, reference.key, effort, args.matchSteps])); if (existing.has(key)) continue;
    const points = () => rows.filter(r => r.identityHash === identityHash && r.image === image.id && r.mode === 'lossy' && r.effort === effort && r.metrics);
    const result = {key, referenceKey: reference.key, reference: compact(reference), image: image.id, effort, identityHash, metrics: {}};
    for (const metric of ['ssimulacra2', 'butteraugli']) {
      const target = reference.metrics[metric], tolerance = metric === 'ssimulacra2' ? .25 : Math.max(.02, target * .02);
      const signed = row => (metric === 'ssimulacra2' ? 1 : -1) * (row.metrics[metric] - target);
      let best, bracket;
      for (let step = 0; step <= args.matchSteps; step++) {
        const all = points().sort((a, b) => a.distance - b.distance);
        best = all.reduce((a, b) => !a || Math.abs(signed(b)) < Math.abs(signed(a)) ? b : a, null);
        bracket = null;
        for (let i = 1; i < all.length; i++) if (signed(all[i - 1]) >= 0 && signed(all[i]) <= 0) { bracket = [all[i - 1], all[i]]; break; }
        if (best && Math.abs(signed(best)) <= tolerance || step === args.matchSteps) break;
        let distance;
        if (!bracket) {
          distance = !all.length || signed(all[0]) < 0 ? .01 : 25;
          if (all.some(p => p.distance === distance)) break;
        } else {
          const [a, b] = bracket, fraction = Math.max(.1, Math.min(.9, signed(a) / (signed(a) - signed(b))));
          distance = Number(Math.exp(Math.log(a.distance) + fraction * Math.log(b.distance / a.distance)).toFixed(6));
          if (all.some(p => p.distance === distance)) break;
        }
        await measureLibjxl(image, {mode: 'lossy', effort, distance});
      }
      result.metrics[metric] = {target, tolerance, status: best && Math.abs(signed(best)) <= tolerance ? 'matched' : bracket ? 'bracketed' : 'outside-measured-range',
        measured: best ? compact(best) : null, deviation: best ? best.metrics[metric] - target : null, bracket: bracket?.map(compact) ?? null};
    }
    const sTolerance = .25, bTolerance = Math.max(.02, reference.metrics.butteraugli * .02);
    const eligible = points().filter(row => row.metrics.ssimulacra2 >= reference.metrics.ssimulacra2 - sTolerance && row.metrics.butteraugli <= reference.metrics.butteraugli + bTolerance).sort((a, b) => a.bytes - b.bytes);
    result.jointAtLeast = eligible.length ? {...compact(eligible[0]), rapierByteRatio: reference.bytes / eligible[0].bytes, tolerances: {ssimulacra2: sTolerance, butteraugli: bTolerance}} : null;
    appendFileSync(output, JSON.stringify(result) + '\n'); console.log(JSON.stringify({matched: image.id, effort, reference: reference.quality, statuses: Object.fromEntries(Object.entries(result.metrics).map(([k, v]) => [k, v.status]))}));
  }
}

try {
  if (args.runtime === 'node') runner = await nodeRunner();
  if (args.runtime === 'chrome') runner = await chromeRunner();
  writeFileSync(join(args.out, 'environment-' + identityHash.slice(0, 16) + '.json'), JSON.stringify(environment, null, 2) + '\n');
  const references = args.match ? readFileSync(args.match, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(row => row.mode === 'lossy' && row.metrics) : [];
  for (const entry of inputs) {
    const image = loadImage(entry);
    if (runner) {
      const buffer = image.data.buffer.slice(image.data.byteOffset, image.data.byteOffset + image.data.byteLength);
      const prepared = await runner.call({kind: 'input', descriptor: entry, ...(args.runtime === 'node' ? {buffer} : {})}, args.runtime === 'node' ? [buffer] : []);
      assert.equal(prepared.hash, entry.rgbaHash);
    }
    for (const mode of args.modes) {
      if (mode === 'lossy' && image.bitDepth !== 8) continue;
      for (const effort of args.efforts) {
        if (mode === 'lossless') await (runner ? measureRapier : measureLibjxl)(image, {mode, effort});
        else if (runner) for (const quality of args.qualities) await measureRapier(image, {mode, effort, quality});
        else for (const distance of args.distances) await measureLibjxl(image, {mode, effort, distance});
      }
    }
    if (args.runtime === 'libjxl' && args.match && image.bitDepth === 8) await matchQuality(image, references.filter(row => row.image === image.id));
  }
  writeFileSync(join(args.out, 'complete-' + identityHash.slice(0, 16) + '.json'), JSON.stringify({identityHash, finishedAt: new Date().toISOString(), rows: rows.filter(row => row.identityHash === identityHash).length, args}, null, 2) + '\n');
} finally {
  if (runner) await runner.close();
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
