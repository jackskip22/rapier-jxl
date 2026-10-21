#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Alternating complete-API and distribution-worker observations. No timing threshold is a test.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {cpus, release} from 'node:os';
import {resolve, dirname, join, relative} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Worker} from 'node:worker_threads';

const [configuration, destination] = process.argv.slice(2);
assert(configuration && destination, 'Use ideal-paired.mjs CONFIG.json OUTPUT_DIRECTORY');
assert.equal(process.version, 'v22.23.3');
const here = dirname(fileURLToPath(import.meta.url)), base = dirname(resolve(configuration)), out = resolve(destination);
const configBytes = readFileSync(configuration), config = JSON.parse(configBytes);
const path = value => resolve(base, value), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const median = xs => { const a = [...xs].sort((a, b) => a - b), k = a.length >> 1; return a.length % 2 ? a[k] : (a[k - 1] + a[k]) / 2; };
const warmups = config.warmups ?? 3, repeats = config.repeats ?? 9;
assert(Number.isInteger(warmups) && warmups >= 0 && Number.isInteger(repeats) && repeats >= 1);
assert(config.variants.length >= 2 && new Set(config.variants.map(x => x.name)).size === config.variants.length);
assert(config.runtimes.every(x => ['node', 'chrome'].includes(x)));
mkdirSync(out, {recursive: true}); mkdirSync(join(out, 'jxl'), {recursive: true});
const corpus = path(config.corpus), manifestBytes = readFileSync(join(corpus, 'manifest.json'));
const manifest = JSON.parse(manifestBytes), images = config.images.map(id => {
  const image = manifest.find(row => row.id === id); assert(image, 'Unknown image ' + id); return image;
});
const routes = new Map(), snapshots = new Map();
const sourceRuntime = readFileSync(join(here, 'ideal-runtime.mjs'));
const bundleRuntime = readFileSync(join(here, 'ideal-bundle-runtime.mjs'));
routes.set('/runtime.mjs', sourceRuntime);
writeFileSync(join(out, 'ideal-runtime.mjs'), sourceRuntime);
writeFileSync(join(out, 'ideal-bundle-runtime.mjs'), bundleRuntime);

function snapshotSource(root) {
  root = path(root); if (snapshots.has(root)) return snapshots.get(root);
  const modules = new Map();
  function visit(file) {
    const name = relative(root, file).replaceAll('\\', '/');
    assert(!name.startsWith('../') && name.endsWith('.mjs'), 'Source import leaves encoder root: ' + name);
    if (modules.has(name)) return;
    const bytes = readFileSync(file); modules.set(name, bytes);
    for (const match of bytes.toString().matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.[^"']+)["']/g)) visit(resolve(dirname(file), match[1]));
  }
  visit(join(root, 'rapier.mjs'));
  const files = Object.fromEntries([...modules].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => [name, hash(bytes)]));
  const sha256 = hash(JSON.stringify(files)), directory = join(out, 'snapshots', sha256), route = '/source/' + sha256;
  for (const [name, bytes] of modules) {
    assert.equal(hash(readFileSync(join(root, name))), files[name], 'Source changed while snapshotting');
    const target = join(directory, name); mkdirSync(dirname(target), {recursive: true}); writeFileSync(target, bytes);
    routes.set(route + '/' + name, bytes);
  }
  const result = {kind: 'source', sha256, files, directory, route}; snapshots.set(root, result); return result;
}

const chromePrefix = helpers => `Object.defineProperty(navigator,'hardwareConcurrency',{value:${helpers + 1},configurable:true});
const measuredSend=globalThis.postMessage.bind(globalThis),MeasuredWorker=globalThis.Worker;
let measuredStart,measuredId,measuredSpawns=0,measuredErrors=0,measuredTasks=0;const measuredResponders=new Set();
globalThis.Worker=class extends MeasuredWorker{constructor(...args){super(...args);measuredSpawns++;this.addEventListener('error',()=>measuredErrors++);this.addEventListener('message',({data})=>{if(data.pool==='photo-done')measuredResponders.add(this);});}postMessage(message,transfer){if(['task','candidate','photo'].includes(message.pool))measuredTasks++;return super.postMessage(message,transfer||[]);}};
globalThis.postMessage=(message,transfer)=>{if(message.id===measuredId&&message.ok!==undefined)message={...message,measured:{ms:performance.now()-measuredStart,workersStarted:measuredSpawns,workerErrors:measuredErrors,workerTasks:measuredTasks,photoResponders:measuredResponders.size}};measuredSend(message,transfer);};\n`;
const chromeSuffix = `\nconst measuredReceive=globalThis.onmessage;globalThis.onmessage=event=>{if(event.data.measurementReady){measuredSend({ready:true});return;}if(event.data.operation==='encode'){measuredStart=performance.now();measuredId=event.data.id;measuredSpawns=0;measuredErrors=0;measuredTasks=0;measuredResponders.clear();}return measuredReceive(event);};\n`;
const variants = config.variants.map((variant, index) => {
  assert([0, 3].includes(variant.helpers), 'Use zero or three helpers');
  assert(Boolean(variant.source) !== Boolean(variant.worker), 'Each variant needs source or worker');
  if (variant.source) return {...variant, ...snapshotSource(variant.source)};
  const bytes = readFileSync(path(variant.worker)), sha256 = hash(bytes), directory = join(out, 'snapshots', sha256);
  mkdirSync(directory, {recursive: true}); const file = join(directory, 'worker.js'); writeFileSync(file, bytes);
  const route = '/bundle/' + index + '.js', instrumented = Buffer.from(chromePrefix(variant.helpers) + bytes.toString() + chromeSuffix);
  routes.set(route, instrumented);
  return {...variant, kind: 'bundle', sha256, file, route, instrumentedSha256: hash(instrumented)};
});
const report = {protocol: 1, startedAt: new Date().toISOString(), configuration: config,
  environment: {node: process.version, platform: process.platform, arch: process.arch, release: release(), cpu: cpus()[0]?.model,
    affinity: readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1]},
  identities: {configuration: hash(configBytes), manifest: hash(manifestBytes), runner: hash(readFileSync(fileURLToPath(import.meta.url))),
    sourceRuntime: hash(sourceRuntime), bundleRuntime: hash(bundleRuntime)}, variants,
  timing: 'API: awaited createEncoder.encode. Bundle: worker encode request handler through final reply. Both include fresh production helper startup and teardown; coordinator import, external transfer, hashing, file work and quality scoring excluded.',
  order: 'Each warmup and timed round alternates forward/reverse variant order. Each image gets fresh coordinators; coordinators persist across its settings.',
  limitations: 'Shared-host desktop observations, not real-phone measurements. No universal helper crossover is inferred. Distinct-source outputs may differ; declared equality groups must have identical complete streams.',
  rows: [], summary: []};
const persist = () => writeFileSync(join(out, 'raw.json'), JSON.stringify(report, null, 2) + '\n');
persist();
let requestId = 0;
function nodeClient(variant) {
  const thread = variant.kind === 'source' ? new Worker(pathToFileURL(join(out, 'ideal-runtime.mjs'))) :
    new Worker(pathToFileURL(join(out, 'ideal-bundle-runtime.mjs')), {workerData: {file: variant.file, helpers: variant.helpers}});
  const pending = new Map(); let ready, rejectReady;
  const initialized = variant.kind === 'bundle' ? new Promise((resolve, reject) => { ready = resolve; rejectReady = reject; }) : null;
  const fail = error => { rejectReady?.(error); for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); };
  thread.on('error', fail);
  thread.on('message', message => {
    if (message.ready && !message.requestId) ready?.();
    const key = message.requestId ?? message.id, p = pending.get(key);
    if (!p || variant.kind === 'bundle' && message.ok === undefined) return;
    pending.delete(key); clearTimeout(p.timer);
    message.failed || message.ok === false ? p.reject(new Error(JSON.stringify(message.failed || message.error))) : p.resolve(message);
  });
  const call = (message, transfer = []) => new Promise((resolve, reject) => {
    const id = ++requestId, timer = setTimeout(() => { pending.delete(id); reject(new Error('Worker timed out')); }, 300000);
    pending.set(id, {resolve, reject, timer}); thread.postMessage({...message, ...(variant.kind === 'source' ? {requestId: id} : {id})}, transfer);
  });
  return {variant, call, initialized, close: () => thread.terminate()};
}
let browser, page, server, origin;
async function startBrowser() {
  const saved = new Map();
  server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/output/')) {
      const chunks = []; for await (const c of req) chunks.push(c); saved.set(req.url, Buffer.concat(chunks)); res.end('ok'); return;
    }
    const bytes = routes.get(req.url);
    if (bytes) { res.setHeader('Content-Type', 'text/javascript'); res.end(bytes); return; }
    const image = images.find(row => req.url === '/input/' + row.id);
    if (image) { res.end(readFileSync(join(corpus, image.pixels))); return; }
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>JPEG XL paired measurement</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + server.address().port;
  const {chromium} = await import(pathToFileURL(path(config.playwright)));
  browser = await chromium.launch({executablePath: path(config.chrome), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']});
  assert.equal(browser.version(), '155.0.8059.39'); report.environment.chrome = browser.version();
  page = await browser.newPage(); await page.goto(origin);
  await page.evaluate(() => { globalThis.clients = []; globalThis.serial = 0; });
  return saved;
}
const expected = new Map(), groupHashes = new Map();
try {
  for (const runtime of config.runtimes) {
    const saved = runtime === 'chrome' ? await startBrowser() : null;
    for (const image of images) {
      const pixels = readFileSync(join(corpus, image.pixels)); assert.equal(hash(pixels), image.rgbaHash);
      assert.equal(image.bitDepth, 8, 'Paired photographic observations use RGBA8');
      const clients = [];
      try {
        for (const variant of variants) {
          if (runtime === 'node') {
            const client = nodeClient(variant); clients.push(client);
            if (variant.kind === 'source') {
              await client.call({kind: 'init', root: pathToFileURL(variant.directory).href, helpers: variant.helpers});
              const data = Uint8Array.from(pixels); await client.call({kind: 'input', descriptor: image, buffer: data.buffer}, [data.buffer]);
            } else await client.initialized;
          } else {
            const index = await page.evaluate(async ({variant, image, origin}) => {
              const worker = new Worker(variant.kind === 'source' ? '/runtime.mjs' : variant.route, variant.kind === 'source' ? {type: 'module'} : undefined);
              const waiting = new Map(); let ready, rejectReady;
              const initialized = variant.kind === 'bundle' ? new Promise((resolve, reject) => { ready = resolve; rejectReady = reject; }) : null;
              worker.onmessage = ({data}) => {
                if (data.ready && !data.requestId) ready?.();
                const key = data.requestId ?? data.id, p = waiting.get(key);
                if (!p || variant.kind === 'bundle' && data.ok === undefined) return;
                waiting.delete(key); clearTimeout(p.timer);
                data.failed || data.ok === false ? p.reject(new Error(JSON.stringify(data.failed || data.error))) : p.resolve(data);
              };
              worker.onerror = error => { const failure = new Error(error.message); rejectReady?.(failure); for (const p of waiting.values()) { clearTimeout(p.timer); p.reject(failure); } waiting.clear(); };
              const call = (message, transfer = []) => new Promise((resolve, reject) => {
                const id = ++serial, timer = setTimeout(() => { waiting.delete(id); reject(new Error('Worker timed out')); }, 300000);
                waiting.set(id, {resolve, reject, timer}); worker.postMessage({...message, ...(variant.kind === 'source' ? {requestId: id} : {id})}, transfer);
              });
              const pixels = new Uint8Array(await (await fetch('/input/' + image.id)).arrayBuffer());
              if (variant.kind === 'source') {
                await call({kind: 'init', root: origin + variant.route, helpers: variant.helpers});
                const copy = pixels.slice(); await call({kind: 'input', descriptor: image, buffer: copy.buffer}, [copy.buffer]);
              } else { worker.postMessage({measurementReady: true}); await initialized; }
              clients.push({worker, call, pixels}); return clients.length - 1;
            }, {variant, image, origin});
            clients.push({variant, index});
          }
        }
        for (const effort of config.efforts) for (const quality of config.qualities) {
          const options = {photo: true, quality, effort, ...config.options};
          for (let round = -warmups; round < repeats; round++) {
            const ordered = (round + warmups) % 2 ? [...clients].reverse() : clients;
            for (const client of ordered) {
              const {variant} = client; let reply, bytes, sample;
              if (runtime === 'node') {
                if (variant.kind === 'source') reply = await client.call({kind: 'measure', options, warmups: 0, repeats: 1});
                else {
                  const data = Uint8Array.from(pixels);
                  reply = await client.call({operation: 'encode', data, width: image.width, height: image.height, options: {...options, parallel: variant.helpers > 0}}, [data.buffer]);
                }
                bytes = Buffer.from(reply.bytes); sample = variant.kind === 'source' ? reply.samples[0] : reply.measured;
              } else {
                const output = '/output/' + ++requestId;
                const result = await page.evaluate(async ({index, variant, image, options, output}) => {
                  const c = clients[index]; let reply;
                  if (variant.kind === 'source') reply = await c.call({kind: 'measure', options, warmups: 0, repeats: 1});
                  else { const data = c.pixels.slice(); reply = await c.call({operation: 'encode', data, width: image.width, height: image.height, options: {...options, parallel: variant.helpers > 0}}, [data.buffer]); }
                  await fetch(output, {method: 'POST', body: reply.bytes});
                  return {sample: variant.kind === 'source' ? reply.samples[0] : reply.measured};
                }, {index: client.index, variant, image, options, output});
                bytes = saved.get(output); saved.delete(output); sample = result.sample;
              }
              assert(bytes && sample && Number.isFinite(sample.ms)); assert.equal(sample.workerErrors, 0, 'Worker errors invalidate timing');
              const sha256 = hash(bytes), key = [variant.name, image.id, effort, quality].join('/');
              if (expected.has(key)) assert.equal(sha256, expected.get(key), 'Output changed across samples or runtimes');
              else { expected.set(key, sha256); writeFileSync(join(out, 'jxl', hash(key).slice(0, 20) + '.jxl'), bytes); }
              if (variant.equalGroup) {
                const key = [variant.equalGroup, image.id, effort, quality].join('/');
                if (groupHashes.has(key)) assert.equal(sha256, groupHashes.get(key), 'Serial, helper or bundled output differs');
                else groupHashes.set(key, sha256);
              }
              report.rows.push({runtime, variant: variant.name, kind: variant.kind, image: image.id, inputHash: image.rgbaHash,
                width: image.width, height: image.height, effort, quality, helpersRequested: variant.helpers,
                round, warmup: round < 0, ...sample, bytes: bytes.length, sha256}); persist();
            }
          }
          console.log(JSON.stringify({runtime, image: image.id, effort, quality, completed: report.rows.length}));
        }
      } finally {
        if (runtime === 'node') await Promise.all(clients.map(c => c.close()));
        else await page.evaluate(() => { for (const c of clients) c.worker.terminate(); clients = []; });
      }
    }
    if (browser) { await browser.close(); browser = null; await new Promise(resolve => server.close(resolve)); server = null; }
  }
} finally {
  if (browser) await browser.close(); if (server) await new Promise(resolve => server.close(resolve));
}
for (const runtime of config.runtimes) for (const variant of variants) for (const image of images)
  for (const effort of config.efforts) for (const quality of config.qualities) {
    const rows = report.rows.filter(r => r.runtime === runtime && r.variant === variant.name && r.image === image.id && r.effort === effort && r.quality === quality && !r.warmup);
    assert.equal(rows.length, repeats);
    const times = rows.map(r => r.ms);
    report.summary.push({runtime, variant: variant.name, image: image.id, effort, quality, samples: times,
      medianMs: median(times), minMs: Math.min(...times), maxMs: Math.max(...times),
      medianMsPerMP: median(times) * 1e6 / image.width / image.height,
      helpersPerSample: rows.map(r => r.workersStarted), bytes: rows[0].bytes, sha256: rows[0].sha256});
  }
report.completedAt = new Date().toISOString(); persist();
console.log(JSON.stringify({rows: report.rows.length, settings: report.summary.length, output: join(out, 'raw.json')}));
