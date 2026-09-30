// SPDX-License-Identifier: MIT
// Measurement only, never a timing gate. --browser uses real CDP 4x CPU throttling; --node is labelled unthrottled.
// Usage: node public/test/phone-benchmark.mjs --node --input photograph.jpg
// Browser: under the shared browser lock, env RAPIER_WITNESS_LOCKED=1 node public/test/phone-benchmark.mjs --browser --input photograph.jpg
import {readFile, access} from 'node:fs/promises';
import {createServer} from 'node:http';
import {spawnSync} from 'node:child_process';
import {Worker} from 'node:worker_threads';
import {resolve, extname, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const args = process.argv.slice(2), option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const root = resolve(option('--root') || fileURLToPath(new URL('../../', import.meta.url)));
const input = option('--input'), width = 4000, height = 3000;
if (!input || (!args.includes('--browser') && !args.includes('--node'))) throw new Error('Choose --node or --browser and --input photograph.jpg (or a 4000x3000 .rgba file)');
let rgba;
if (extname(input) === '.rgba') rgba = new Uint8Array(await readFile(input));
else {
  const decoded = spawnSync(process.env.JXL_FUZZ_FFMPEG || 'ffmpeg', ['-v', 'error', '-i', resolve(input), '-vf', `scale=${width}:${height}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-threads', '1', 'pipe:1'], {maxBuffer: width * height * 4 + 65536});
  if (decoded.error || decoded.status !== 0) throw decoded.error || new Error(decoded.stderr.toString());
  rgba = new Uint8Array(decoded.stdout);
}
if (rgba.length !== width * height * 4) throw new Error('Input must decode to exactly 4000x3000 RGBA');
const entries = [{name: 'lossless', file: 'index.mjs', quality: 100}, {name: 'lossy', file: 'index.mjs', quality: 90}];
try { await access(resolve(root, 'photo.mjs')); entries.push({name: 'photo', file: 'photo.mjs', quality: 90, photo: true}); } catch {}
const report = {runtime: process.version, mode: args.includes('--browser') ? 'browser-CDP-4x' : 'Node-unthrottled', width, height, pixels: width * height, input: resolve(input), rgbaSHA256: createHash('sha256').update(rgba).digest('hex'), measurements: []};

async function nodeRun(entry, cancel) {
  return new Promise((done, reject) => {
    const copy = rgba.slice(), worker = new Worker(new URL('./benchmark-worker.mjs', import.meta.url), {workerData: {module: pathToFileURL(resolve(root, entry.file)).href, rgba: copy, width, height, ...entry}, transferList: [copy.buffer]});
    let started, timer, received = false;
    worker.on('error', reject);
    worker.on('message', message => {
      if (message.started) {
        started = performance.now();
        if (cancel) timer = setTimeout(async () => {
          const called = performance.now(), exitCode = await worker.terminate();
          done({cancelRequestedAfterMs: called - started, terminateMs: performance.now() - called, exitCode, completedBeforeCancel: received});
        }, 100);
      } else {
        received = true;
        if (!cancel) { clearTimeout(timer); worker.terminate().then(() => done(message), reject); }
      }
    });
  });
}

if (report.mode === 'Node-unthrottled') {
  for (const entry of entries) {
    const timing = await nodeRun(entry, false), cancellation = await nodeRun(entry, true);
    report.measurements.push({entry: entry.name, quality: entry.quality, timing, cancellation});
    process.stderr.write(JSON.stringify(report.measurements.at(-1)) + '\n');
  }
} else {
  if (process.env.RAPIER_WITNESS_LOCKED !== '1') throw new Error('Take the shared browser lock shown in this file before running browser measurements');
  const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  let browser, server;
  try {
    browser = await playwright.chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH} : {})});
    server = createServer(async (request, response) => {
      try {
        if (request.url === '/pixels.rgba') { response.end(rgba); return; }
        if (request.url === '/') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><title>Encoder timing</title>'); return; }
        const file = resolve(root, '.' + new URL(request.url, 'http://localhost').pathname);
        if (!file.startsWith(root + sep) || extname(file) !== '.mjs') { response.writeHead(404).end(); return; }
        response.setHeader('content-type', 'text/javascript'); response.end(await readFile(file));
      } catch { response.writeHead(404).end(); }
    });
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
    const page = await browser.newPage(), session = await page.context().newCDPSession(page);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await session.send('Emulation.setCPUThrottlingRate', {rate: 4});
    report.browser = browser.version(); report.cpuThrottlingRate = 4;
    for (const entry of entries) {
      const timing = await page.evaluate(async ({entry, width, height}) => {
        const data = new Uint8Array(await (await fetch('/pixels.rgba')).arrayBuffer()), module = await import('/' + entry.file);
        const before = performance.memory?.usedJSHeapSize, start = performance.now();
        const bytes = (entry.photo ? module.encodePhotoRGBA : module.encode)(data, width, height, {quality: entry.quality});
        return {bytes: bytes.length, ms: performance.now() - start, heapBefore: before, heapAfter: performance.memory?.usedJSHeapSize};
      }, {entry, width, height});
      const cancellation = await page.evaluate(async ({entry, width, height}) => {
        const source = `import * as module from ${JSON.stringify(location.origin + '/' + entry.file)}; onmessage=({data})=>{postMessage({started:true});const bytes=module.${entry.photo ? 'encodePhotoRGBA' : 'encode'}(data.rgba,data.width,data.height,{quality:data.quality});postMessage({bytes:bytes.length});};`;
        const url = URL.createObjectURL(new Blob([source], {type: 'text/javascript'})), worker = new Worker(url, {type: 'module'});
        const rgba = new Uint8Array(await (await fetch('/pixels.rgba')).arrayBuffer());
        return await new Promise((done, reject) => {
          let received = false;
          worker.onerror = event => { URL.revokeObjectURL(url); worker.terminate(); reject(new Error(event.message)); };
          worker.onmessage = ({data}) => {
            if (!data.started) { received = true; return; }
            const started = performance.now();
            setTimeout(() => {
              const called = performance.now(); worker.terminate(); const terminateMs = performance.now() - called;
              URL.revokeObjectURL(url);
              done({cancelRequestedAfterMs: called - started, terminateCallMs: terminateMs, completedBeforeCancel: received, note: 'Termination-call latency; worker CPU rate and reclamation completion are not observed.'});
            }, 100);
          };
          worker.postMessage({rgba, width, height, quality: entry.quality}, [rgba.buffer]);
        });
      }, {entry, width, height});
      report.measurements.push({entry: entry.name, quality: entry.quality, timing, cancellation});
    }
  } catch (error) { report.unavailable = String(error); process.exitCode = 1; }
  finally { if (server) await new Promise(done => server.close(done)); if (browser) await browser.close(); }
}
console.log(JSON.stringify(report, null, 2));
