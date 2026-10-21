#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Measure the routing decision with real pixels and two independent decoders.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, appendFileSync, mkdirSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve, join, dirname, relative} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {cpus} from 'node:os';
import {sha256, writePng} from './image-io.mjs';
import {readIdealPng} from './ideal-corpus.mjs';

const [configuration, destination] = process.argv.slice(2);
assert(configuration && destination, 'Use ideal-routes.mjs CONFIG.json OUTPUT_DIRECTORY');
assert.equal(process.version, 'v22.23.3');
const config = JSON.parse(readFileSync(configuration)), base = dirname(resolve(configuration)), out = resolve(destination);
const path = value => resolve(base, value), run = promisify(execFile);
const median = xs => { const a = [...xs].sort((a, b) => a - b), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const encoder = path(config.encoder), corpus = path(config.corpus), tools = path(config.tools), oxide = path(config.oxide);
const warmups = config.warmups ?? 1, repeats = config.repeats ?? 3, mode = config.kernels ?? 'off';
mkdirSync(out, {recursive: true});
for (const dir of ['jxl', 'decoded', 'references']) mkdirSync(join(out, dir), {recursive: true});
function snapshotSource(directory, entry) {
  const originals = new Map();
  function visit(file) {
    const name = relative(directory, file).replaceAll('\\', '/');
    assert(!name.startsWith('../') && name.endsWith('.mjs'));
    if (originals.has(name)) return;
    const bytes = readFileSync(file); originals.set(name, bytes);
    for (const match of bytes.toString().matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.[^"']+)["']/g)) visit(resolve(dirname(file), match[1]));
  }
  for (const file of [entry, 'kernels.mjs']) visit(join(directory, file));
  const sourceFiles = Object.fromEntries([...originals].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => [name, sha256(bytes)]));
  const sourceHash = sha256(JSON.stringify(sourceFiles)), snapshot = join(out, 'source', sourceHash);
  for (const [name, bytes] of originals) {
    assert.equal(sha256(readFileSync(join(directory, name))), sourceFiles[name]);
    const target = join(snapshot, name); mkdirSync(dirname(target), {recursive: true}); writeFileSync(target, bytes);
  }
  return {sourceHash, sourceFiles, root: pathToFileURL(snapshot).href};
}
const before = snapshotSource(encoder, 'index.mjs');
const after = snapshotSource(config.candidate ? path(config.candidate) : encoder, config.candidate ? 'index.mjs' : 'photo.mjs');
const {encode} = await import(before.root + '/index.mjs');
const photo = await import(after.root + '/' + (config.candidate ? 'index.mjs' : 'photo.mjs'));
const encodePhoto = config.candidate ? photo.encode : photo.encodePhoto;
for (const source of [before, after]) { const kernels = await import(source.root + '/kernels.mjs'); kernels.configureKernels(mode); source.kernelMode = kernels.kernelMode(); }
const versions = {};
for (const [name, file] of [['djxl', join(tools, 'djxl')], ['oxide', oxide]]) {
  const result = await run(file, ['--version']); versions[name] = (result.stdout + result.stderr).trim();
  assert(versions[name].includes(name === 'oxide' ? '0.12.6' : '0.12.0'));
}
const toolHashes = Object.fromEntries(['djxl', 'ssimulacra2', 'butteraugli_main'].map(name => [name, sha256(readFileSync(join(tools, name)))]));
toolHashes.oxide = sha256(readFileSync(oxide));
const manifestBytes = readFileSync(join(corpus, 'manifest.json')), manifest = JSON.parse(manifestBytes);
const report = {startedAt: new Date().toISOString(), before, after, config, versions, toolHashes,
  identity: {node: process.version, cpu: cpus()[0]?.model, corpusHash: sha256(manifestBytes), harnessHash: sha256(readFileSync(fileURLToPath(import.meta.url)))},
  protocol: 'Existing core encode(photo:false) versus candidate core default (or encodePhoto without --candidate), effort1. Alternating AB/BA. Source and copy preparation, hashing, decodes and scoring excluded from encode times. Alpha scored over black and white in linear sRGB, worse score retained.',
  rows: []};
writeFileSync(join(out, 'environment.json'), JSON.stringify(report, null, 2) + '\n');
const linear = Float64Array.from({length: 256}, (_, i) => { const x = i / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; });
function composite(data, background) {
  const pixels = new Uint8Array(data.length);
  for (let i = 0; i < pixels.length; i += 4) {
    const a = data[i + 3] / 255;
    for (let c = 0; c < 3; c++) {
      const x = linear[data[i + c]] * a + background * (1 - a);
      pixels[i + c] = Math.round(255 * (x <= .0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - .055));
    }
    pixels[i + 3] = 255;
  }
  return pixels;
}
async function score(reference, output) {
  const result = {};
  for (const [name, file] of [['ssimulacra2', 'ssimulacra2'], ['butteraugli', 'butteraugli_main']]) {
    const r = await run(join(tools, file), [reference, output], {timeout: 180000});
    result[name] = Number.parseFloat(r.stdout); assert(Number.isFinite(result[name]));
  }
  return result;
}
for (const id of config.images) {
  const image = manifest.find(row => row.id === id); assert(image && image.bitDepth === 8);
  const data = new Uint8Array(readFileSync(join(corpus, image.pixels))); assert.equal(sha256(data), image.rgbaHash);
  const opaque = data.every((value, i) => i % 4 !== 3 || value === 255);
  for (const quality of config.qualities) {
    const choices = [{name: 'core-modular', encode, options: {photo: false}, samples: [], warmupSamples: []}, {name: config.candidate ? 'candidate-core' : 'photo-vardct', encode: encodePhoto, options: {}, samples: [], warmupSamples: []}];
    for (let round = -warmups; round < repeats; round++) for (const choice of (round + warmups) % 2 ? [...choices].reverse() : choices) {
      const copy = data.slice(), cpu = process.cpuUsage(), start = performance.now();
      const bytes = choice.encode(copy, image.width, image.height, {quality, effort: 1, ...choice.options});
      const ms = performance.now() - start, used = process.cpuUsage(cpu), digest = sha256(bytes);
      if (choice.sha256) assert.equal(choice.sha256, digest); else choice.sha256 = digest;
      choice.bytes = bytes;
      (round < 0 ? choice.warmupSamples : choice.samples).push({ms, cpuMs: (used.user + used.system) / 1000});
    }
    for (const choice of choices) {
      const key = `${id}-q${quality}-${choice.name}`, file = join(out, 'jxl', key + '.jxl'); writeFileSync(file, choice.bytes);
      const decodes = {}, results = {};
      for (const decoder of ['djxl', 'oxide']) {
        const png = join(out, 'decoded', key + '-' + decoder + '.png');
        await run(decoder === 'djxl' ? join(tools, 'djxl') : oxide,
          decoder === 'djxl' ? [file, png, '--num_threads=0', '--bits_per_sample=8'] : [file, '-o', png, '-f', 'png8', '-j', '1'], {timeout: 300000});
        const decoded = readIdealPng(readFileSync(png)); assert.equal(decoded.width, image.width); assert.equal(decoded.height, image.height);
        let alphaChangedSamples = 0, changedSamples = 0;
        for (let i = 0; i < data.length; i++) if (data[i] !== decoded.rgba[i]) { changedSamples++; if (i % 4 === 3) alphaChangedSamples++; }
        assert.equal(alphaChangedSamples, 0); if (quality >= 100) assert.equal(changedSamples, 0);
        decodes[decoder] = {decoded: true, alphaChangedSamples, changedSamples}; results[decoder] = {...decoded, png};
      }
      let maxDecoderDifference = 0;
      for (let i = 0; i < data.length; i++) maxDecoderDifference = Math.max(maxDecoderDifference, Math.abs(results.djxl.rgba[i] - results.oxide.rgba[i]));
      assert(maxDecoderDifference <= 1);
      let metrics;
      if (quality >= 100) metrics = null;
      else if (opaque) metrics = await score(join(corpus, image.png), results.djxl.png);
      else {
        const backgrounds = {};
        for (const [name, value] of [['black', 0], ['white', 1]]) {
          const reference = join(out, 'references', id + '-' + name + '.png'), output = join(out, 'decoded', key + '-' + name + '.png');
          writeFileSync(reference, writePng(image.width, image.height, composite(data, value)));
          writeFileSync(output, writePng(image.width, image.height, composite(results.djxl.rgba, value)));
          backgrounds[name] = await score(reference, output);
        }
        metrics = {ssimulacra2: Math.min(backgrounds.black.ssimulacra2, backgrounds.white.ssimulacra2), butteraugli: Math.max(backgrounds.black.butteraugli, backgrounds.white.butteraugli), backgrounds};
      }
      const ms = median(choice.samples.map(x => x.ms));
      const row = {image: id, width: image.width, height: image.height, inputHash: image.rgbaHash, quality, effort: 1, route: choice.name,
        bytes: choice.bytes.length, sha256: choice.sha256, ms, msPerMP: ms * 1e6 / image.width / image.height,
        samples: choice.samples, warmupSamples: choice.warmupSamples, decodes, maxDecoderDifference, metrics, encoded: 'jxl/' + key + '.jxl'};
      report.rows.push(row); appendFileSync(join(out, 'results.jsonl'), JSON.stringify(row) + '\n');
      console.log(JSON.stringify({image: id, quality, route: choice.name, bytes: row.bytes, ms: row.ms, ...metrics}));
    }
  }
}
report.completedAt = new Date().toISOString(); writeFileSync(join(out, 'raw.json'), JSON.stringify(report, null, 2) + '\n');
