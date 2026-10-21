#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Qualify saved benchmark streams with the browser's actual JPEG XL decoder.
// JavaScript encoding in Chrome is a different test; this helper does not load Rapier.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {createServer} from 'node:http';
import {resolve, join, dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {sha256} from './image-io.mjs';
import {readIdealPng} from './ideal-corpus.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, ''), value = process.argv[i + 1];
  assert(value && !value.startsWith('--'), 'Every option needs a value');
  assert(['dataset', 'corpus', 'out', 'chrome', 'playwright', 'ids', 'efforts', 'qualities', 'identity', 'modes'].includes(key), 'Unknown option: ' + key);
  args[key] = value;
}
for (const key of ['dataset', 'corpus', 'out', 'chrome']) assert(args[key], 'Missing --' + key);
assert.equal(process.version, 'v22.23.3', 'Use pinned Node 22.23.3');
for (const key of ['dataset', 'corpus', 'out', 'chrome', 'playwright']) if (args[key]) args[key] = resolve(args[key]);
const datasetBytes = readFileSync(join(args.dataset, 'results.jsonl'));
const allRows = datasetBytes.toString().trim().split('\n').filter(Boolean).map(JSON.parse);
const ids = args.ids?.split(','), efforts = args.efforts?.split(',').map(Number), qualities = args.qualities?.split(',').map(Number), modes = args.modes?.split(',');
const rows = allRows.filter(row => (!args.identity || row.identityHash === args.identity) && (!ids || ids.includes(row.image)) &&
  (!efforts || efforts.includes(row.effort)) && (!qualities || qualities.includes(row.quality)) && (!modes || modes.includes(row.mode)));
assert(rows.length, 'No selected benchmark rows');
assert(new Set(rows.map(row => row.identityHash)).size === 1, 'Select --identity for a mixed dataset');
const manifestBytes = readFileSync(join(args.corpus, 'manifest.json')), manifest = JSON.parse(manifestBytes);
const inputs = new Map(manifest.map(row => [row.id, row])), routes = new Map();
const receipt = {protocol: 1, createdAt: new Date().toISOString(), node: process.version,
  datasetSha256: sha256(datasetBytes), corpusSha256: sha256(manifestBytes), identityHash: rows[0].identityHash,
  chromeExecutableSha256: sha256(readFileSync(args.chrome)), selectedKeys: rows.map(row => row.key),
  boundary: 'Native Chrome decodes of saved JPEG XL bytes. RGBA8 canvas readback; no Rapier encoder imported.',
  checks: 'Exact dimensions and alpha for SDR. At opaque pixels, lossless RGB equals the source and lossy RGB differs from djxl by at most one. Partial-alpha and hidden RGB are reported separately because canvas premultiplication can change them. HDR is explicitly skipped from this RGBA8 precision gate.',
  rows: []};
for (const row of rows) {
  const source = inputs.get(row.image); assert(source); assert.equal(row.inputHash, source.rgbaHash);
  const encoded = readFileSync(join(args.dataset, row.encoded)); assert.equal(sha256(encoded), row.sha256);
  routes.set('/jxl/' + row.key, {bytes: encoded, type: 'image/jxl'});
  if (source.bitDepth !== 8) continue;
  const raw = readFileSync(join(args.corpus, source.pixels)); assert.equal(sha256(raw), source.rgbaHash);
  const decoded = readIdealPng(readFileSync(join(args.dataset, 'decoded', row.key.slice(0, 24) + '-djxl.png')));
  assert.equal(decoded.width, source.width); assert.equal(decoded.height, source.height);
  routes.set('/source/' + row.key, {bytes: raw, type: 'application/octet-stream'});
  routes.set('/decoded/' + row.key, {bytes: Buffer.from(decoded.rgba), type: 'application/octet-stream'});
}
const server = createServer((request, response) => {
  const route = routes.get(request.url);
  if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Native JPEG XL qualification</title>'); }
  else if (route) { response.setHeader('Content-Type', route.type); response.end(route.bytes); }
  else response.writeHead(404).end();
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let browser;
try {
  const playwright = await import(args.playwright ? pathToFileURL(args.playwright).href : 'playwright');
  browser = await playwright.chromium.launch({executablePath: args.chrome, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-automation']});
  receipt.chrome = browser.version(); assert.equal(receipt.chrome, '155.0.8059.39', 'Use pinned Chrome 155.0.8059.39');
  const cdp = await browser.newBrowserCDPSession();
  receipt.chromeCommandLine = (await cdp.send('Browser.getBrowserCommandLine')).arguments;
  assert(!receipt.chromeCommandLine.some(arg => /enable.*(?:jxl|jpeg.?xl)/i.test(arg)), 'Do not enable JPEG XL with an experimental flag');
  const page = await browser.newPage(); await page.goto('http://127.0.0.1:' + server.address().port);
  receipt.imageDecoderSupported = await page.evaluate(() => typeof ImageDecoder !== 'undefined' && ImageDecoder.isTypeSupported('image/jxl'));
  for (const row of rows) {
    const source = inputs.get(row.image);
    const result = {key: row.key, image: row.image, mode: row.mode, effort: row.effort, quality: row.quality,
      inputHash: row.inputHash, encodedSha256: row.sha256, encodedBytes: row.bytes, width: row.width, height: row.height, bitDepth: row.bitDepth};
    if (row.bitDepth !== 8) {
      result.skipped = 'RGBA8 canvas readback does not qualify native 16-bit HDR sample precision'; receipt.rows.push(result); continue;
    }
    result.apis = await page.evaluate(async descriptor => {
      const encoded = await (await fetch('/jxl/' + descriptor.key)).arrayBuffer();
      const source = new Uint8Array(await (await fetch('/source/' + descriptor.key)).arrayBuffer());
      const reference = new Uint8Array(await (await fetch('/decoded/' + descriptor.key)).arrayBuffer());
      const results = {};
      for (const api of ['createImageBitmap', 'createImageBitmap-explicit', 'ImageDecoder']) {
        const started = performance.now(); let image, decoder;
        try {
          if (api === 'ImageDecoder') {
            decoder = new ImageDecoder({data: encoded.slice(0), type: 'image/jxl', colorSpaceConversion: 'none'});
            image = (await decoder.decode({frameIndex: 0})).image;
          } else image = await createImageBitmap(new Blob([encoded], {type: 'image/jxl'}), ...(api === 'createImageBitmap-explicit' ?
            [{premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none'}] : []));
          const width = image.displayWidth ?? image.width, height = image.displayHeight ?? image.height;
          const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d', {willReadFrequently: true, colorSpace: 'srgb'});
          context.drawImage(image, 0, 0); const actual = context.getImageData(0, 0, width, height).data;
          let alphaChanges = 0, opaqueChanges = 0, maxOpaqueDifference = 0, partialChanges = 0, hiddenChanges = 0;
          let opaquePixels = 0, partialPixels = 0, hiddenPixels = 0;
          for (let at = 0; at < source.length; at += 4) {
            if (actual[at + 3] !== source[at + 3]) alphaChanges++;
            const alpha = source[at + 3];
            if (alpha === 255) opaquePixels++; else if (alpha === 0) hiddenPixels++; else partialPixels++;
            for (let c = 0; c < 3; c++) {
              const expected = descriptor.mode === 'lossless' ? source[at + c] : reference[at + c];
              const difference = Math.abs(actual[at + c] - expected);
              if (alpha === 255) { if (difference) opaqueChanges++; maxOpaqueDifference = Math.max(maxOpaqueDifference, difference); }
              else if (difference) { if (alpha === 0) hiddenChanges++; else partialChanges++; }
            }
          }
          const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', actual))).map(byte => byte.toString(16).padStart(2, '0')).join('');
          results[api] = {decoded: true, passed: width === descriptor.width && height === descriptor.height && alphaChanges === 0 && maxOpaqueDifference <= (descriptor.mode === 'lossless' ? 0 : 1),
            width, height, alphaChanges, opaqueChanges, maxOpaqueDifference, partialChanges, hiddenChanges, opaquePixels, partialPixels, hiddenPixels,
            rgbaSha256: digest, ms: performance.now() - started};
        } catch (error) { results[api] = {decoded: false, passed: false, error: error.name + ': ' + error.message, ms: performance.now() - started}; }
        finally { image?.close(); decoder?.close(); }
      }
      return results;
    }, result);
    receipt.rows.push(result);
    console.log(JSON.stringify({image: row.image, mode: row.mode, effort: row.effort, quality: row.quality,
      passed: Object.values(result.apis).filter(api => api.passed).length, total: Object.keys(result.apis).length}));
  }
  const observations = receipt.rows.flatMap(row => Object.values(row.apis || {}));
  receipt.summary = {selectedStreams: rows.length, testedStreams: receipt.rows.filter(row => row.apis).length,
    skippedStreams: receipt.rows.filter(row => row.skipped).length, apiObservations: observations.length,
    passed: observations.filter(row => row.passed).length, failed: observations.filter(row => !row.passed).length};
  mkdirSync(dirname(args.out), {recursive: true}); writeFileSync(args.out, JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt.summary)); if (receipt.summary.failed) process.exitCode = 1;
} finally { if (browser) await browser.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
