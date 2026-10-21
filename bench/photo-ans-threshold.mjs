// SPDX-License-Identifier: MIT
// Measure the existing prefix and ANS photo entry points at efforts 2 and 3.
// node photo-ans-threshold.mjs SOURCE CORPUS_MANIFEST OUTPUT_DIR DJXL OXIDE
// node photo-ans-threshold.mjs --summarize RECEIPT
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {join, dirname, resolve, relative} from 'node:path';
import {cpus} from 'node:os';
import {readPng} from './image-io.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const median = values => [...values].sort((a, b) => a - b)[values.length >> 1];
export function summarize(receipt) {
  assert.equal(receipt.complete, true);
  return Object.fromEntries([2, 3].map(effort => {
    const rows = receipt.rows.filter(row => row.effort === effort);
    return [effort, {rows: rows.length,
      medianBytePercent: median(rows.map(row => 100 * (row.ans.bytes / row.photo.bytes - 1))),
      medianTimeRatio: median(rows.map(row => row.ans.medianMs / row.photo.medianMs)),
      smaller: rows.filter(row => row.ans.bytes < row.photo.bytes).length,
      sameDecodedPixels: rows.filter(row => row.decodedPixelsEqual).length}];
  }));
}

async function main() {
  if (process.argv[2] === '--summarize') {
    console.log(JSON.stringify(summarize(JSON.parse(readFileSync(process.argv[3], 'utf8'))), null, 2)); return;
  }
  const [sourceArg, corpusArg, outputArg, djxl, oxide] = process.argv.slice(2);
  assert.ok(sourceArg && corpusArg && outputArg && djxl && oxide, 'SOURCE CORPUS_MANIFEST OUTPUT_DIR DJXL OXIDE are required.');
  const source = resolve(sourceArg), corpusPath = resolve(corpusArg), corpus = dirname(corpusPath), out = resolve(outputArg), snapshot = join(out, 'source');
  const graph = new Map();
  const visit = path => {
    if (graph.has(path)) return;
    const bytes = readFileSync(path); graph.set(path, bytes);
    for (const match of bytes.toString('utf8').matchAll(/(?:\bfrom\s*|\bimport\s*)(['"])(\.[^'"]+\.mjs)\1/g)) visit(resolve(dirname(path), match[2]));
  };
  for (const entry of ['photo.mjs', 'photo-ans.mjs', 'kernels.mjs']) visit(join(source, entry));
  const sources = {};
  for (const [path, bytes] of graph) {
    const name = relative(source, path); assert.ok(!name.startsWith('..'));
    const target = join(snapshot, name); mkdirSync(dirname(target), {recursive: true}); writeFileSync(target, bytes); sources[name] = digest(bytes);
  }
  const encoders = {
    photo: (await import(pathToFileURL(join(snapshot, 'photo.mjs')))).encodePhoto,
    ans: (await import(pathToFileURL(join(snapshot, 'photo-ans.mjs')))).encodePhoto,
  };
  const kernelMode = (await import(pathToFileURL(join(snapshot, 'kernels.mjs')))).configureKernels('auto');
  assert.equal(kernelMode, 'simd');
  const manifestBytes = readFileSync(corpusPath), photos = JSON.parse(manifestBytes).filter(photo =>
    ['phone-flower-crop', 'photo-keong', 'photo-ria', 'photo-bliznaca'].includes(photo.id));
  assert.equal(photos.length, 4);
  const command = (tool, args) => execFileSync(tool, args, {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']});
  const receipt = {complete: false, node: process.version, cpu: cpus()[0]?.model, kernelMode, quality: 85,
    protocol: 'Four real photos; quality 85, effort 2/3. Three alternating warmup pairs then seven alternating timed pairs. Actual complete synchronous APIs, no helpers. Every timing returns the pinned stream. Independent decodes verify same reconstructed pixels and exact alpha. No browser/phone timing claim.',
    source: sources, corpusSha256: digest(manifestBytes), programSha256: digest(readFileSync(fileURLToPath(import.meta.url))),
    toolHashes: {djxl: digest(readFileSync(djxl)), oxide: digest(readFileSync(oxide))}, rows: []};
  const save = () => writeFileSync(join(out, 'photo-ans-threshold.json'), JSON.stringify(receipt, null, 2) + '\n');
  save();
  for (const photo of photos) {
    const rgba = new Uint8Array(readFileSync(join(corpus, photo.pixels))); assert.equal(digest(rgba), photo.rgbaHash);
    for (const effort of [2, 3]) {
      const row = {id: photo.id, width: photo.width, height: photo.height, effort, inputSha256: photo.rgbaHash};
      const controls = {}, decoded = {};
      for (const name of ['photo', 'ans']) {
        controls[name] = encoders[name](rgba, photo.width, photo.height, {quality: 85, effort});
        row[name] = {bytes: controls[name].length, sha256: digest(controls[name]), samplesMs: [], samplesCpuMs: []};
        const stem = join(out, `${photo.id}-e${effort}-${name}`); writeFileSync(stem + '.jxl', controls[name]);
        command(djxl, [stem + '.jxl', stem + '.png', '--num_threads=1', '--quiet']);
        command(oxide, [stem + '.jxl', '-o', stem + '-oxide.png', '-f', 'png8', '-j', '1', '-q']);
        const a = readPng(readFileSync(stem + '.png')), b = readPng(readFileSync(stem + '-oxide.png'));
        for (const image of [a, b]) { assert.equal(image.width, photo.width); assert.equal(image.height, photo.height); }
        let maxDifference = 0;
        for (let i = 0; i < rgba.length; i++) {
          if (i % 4 === 3) { assert.equal(a.rgba[i], rgba[i]); assert.equal(b.rgba[i], rgba[i]); }
          else maxDifference = Math.max(maxDifference, Math.abs(a.rgba[i] - b.rgba[i]));
        }
        assert.ok(maxDifference <= 1); row[name].maxDecoderDifference = maxDifference;
        row[name].decodedSha256 = digest(a.rgba); decoded[name] = a.rgba;
      }
      assert.deepEqual(decoded.photo, decoded.ans); row.decodedPixelsEqual = true;
      for (let pair = -3; pair < 7; pair++) {
        for (const name of pair & 1 ? ['ans', 'photo'] : ['photo', 'ans']) {
          const startCpu = process.cpuUsage(), start = performance.now();
          const bytes = encoders[name](rgba, photo.width, photo.height, {quality: 85, effort});
          const ms = performance.now() - start, cpu = process.cpuUsage(startCpu);
          assert.deepEqual(bytes, controls[name]);
          if (pair >= 0) { row[name].samplesMs.push(ms); row[name].samplesCpuMs.push((cpu.user + cpu.system) / 1000); }
        }
      }
      for (const name of ['photo', 'ans']) {
        row[name].medianMs = median(row[name].samplesMs);
        row[name].medianMsPerMp = row[name].medianMs * 1e6 / (photo.width * photo.height);
      }
      assert.equal(digest(rgba), photo.rgbaHash); receipt.rows.push(row); save();
      console.log(JSON.stringify({id: photo.id, effort, photoBytes: row.photo.bytes, ansBytes: row.ans.bytes,
        photoMs: row.photo.medianMs, ansMs: row.ans.medianMs, timeRatio: row.ans.medianMs / row.photo.medianMs}));
    }
  }
  receipt.complete = true; save(); console.log(JSON.stringify(summarize(receipt), null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
