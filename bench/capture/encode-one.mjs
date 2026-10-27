// SPDX-License-Identifier: MIT
// Fresh process per codec/input. Used by run.mjs; not a published API.
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
import {readPng, sha256} from '../image-io.mjs';

async function encoder(config) {
  const {codec, root, tools, quality = 100, effort = 7, maxError = 0} = config;
  const module = name => import(pathToFileURL(resolve(root, 'src', name + '.mjs')));
  if (codec === 'capture') {
    const api = await module('capture-codec');
    return {encode: (data, w, h) => api.encodeCapture(data, w, h, {maxError}), close() {}};
  }
  if (codec === 'writer') {
    const api = await module('writer');
    return {encode: (data, width, height) => api.encodeLossless(data, width, height, {colorSpace: 'srgb'}), close() {}};
  }
  if (codec === 'jpeg' || codec === 'jpeg-ans') {
    const api = await module(codec), jpeg = new Uint8Array(readFileSync(config.jpeg));
    return {encode() {
      const bytes = api.transcode(jpeg, {effort}).bytes;
      const restored = api.reconstructJPEG(bytes);
      if (!restored || sha256(restored) !== sha256(jpeg)) throw new Error('JPEG reconstruction mismatch');
      return bytes;
    }, close() {}};
  }
  if (codec === 'rapier' || codec === 'rapier-still') {
    const api = await module(codec), instance = codec === 'rapier' ? api.createEncoder() : api.createStillEncoder();
    return {encode: (data, width, height) => codec === 'rapier' ? instance.encode({data, width, height}, {quality, effort, parallel: false, gpu: false})
      : instance.encode(data, width, height, {quality, effort, photo: quality < 100, parallel: false, gpu: false}), close() {}};
  }
  if (['core', 'effort', 'wasm', 'photo', 'photo-advanced', 'photo-ans', 'noise', 'graphics', 'hybrid', 'icc', 'delta-palette'].includes(codec)) {
    const api = await module(codec === 'core' ? 'index' : codec === 'noise' ? 'photo-noise' : codec);
    const name = codec.startsWith('photo') || codec === 'noise' ? 'encodePhoto' : codec === 'graphics' ? 'encodeGraphics' : codec === 'hybrid' ? 'encodeHybrid' : codec === 'icc' ? 'encodeProfile' : codec === 'delta-palette' ? 'encodeDeltaPalette' : 'encode';
    const options = codec === 'graphics' ? {maxColorError: maxError} : {quality, effort};
    return {encode: (data, w, h) => api[name](data, w, h, options), close() {}};
  }
  if (codec === 'score') {
    const api = await module('score');
    let result;
    return {encode: async (data, w, h) => {result = await api.encodeToScore(data, w, h, {target: {ssimulacra2: config.target ?? 85}, effort}); return result.bytes;},
      metadata() {const {bytes, ...metrics} = result; return metrics;}, close() {}};
  }
  if (codec === 'photo-plan') {
    const api = await module('photo-plan');
    return {encode(data, w, h) {const plan = api.createPhotoPlan(data, w, h, {quality, effort}); try {return plan.encode(quality);} finally {plan.dispose();}}, close() {}};
  }
  if (codec === 'animation' || codec === 'animation-atlas') {
    const api = await module(codec), name = codec === 'animation' ? 'encodeAnimation' : 'encodeAnimationAtlas';
    return {encode: (data, width, height) => api[name]({width, height, frames: [{data, duration: 100}]}, {quality, effort}), close() {}};
  }
  if (codec === 'channels' || codec === 'layers') {
    const api = await module(codec);
    return {encode(data, width, height) {
      const planes = Array.from({length: 4}, (_, channel) => Uint8Array.from({length: width * height}, (_, i) => data[i * 4 + channel]));
      const image = {width, height, color: planes.slice(0, 3), extraChannels: [{type: 'alpha', data: planes[3]}]};
      return codec === 'channels' ? api.encodeChannels(image) : api.encodeLayers({width, height, layers: [{image}]});
    }, close() {}};
  }
  if (codec === 'splines') {
    const api = await module('splines');
    const stroke = api.splineStroke([[1, 1], [2, 2]], {colorXYB: [0, 0, 0], sigma: 1});
    return {encode: (data, w, h) => api.encodeSplines(data, w, h, {splines: [stroke], quality, effort}), close() {}};
  }
  if (codec === 'patches') {
    const api = await module('patches');
    return {encode: (data, width, height) => api.encodePatches(data, width, height, {atlas: {data: data.slice(0, 4), width: 1, height: 1},
      patches: [{sourceX: 0, sourceY: 0, width: 1, height: 1, positions: [{x: 0, y: 0}]}], effort}), close() {}};
  }
  if (codec === 'jsquash') {
    const {default: factory} = await import(pathToFileURL(resolve(tools, 'jsquash/codec/enc/jxl_enc.js')));
    const {defaultOptions} = await import(pathToFileURL(resolve(tools, 'jsquash/meta.js')));
    const api = await factory({wasmBinary: readFileSync(resolve(tools, 'jsquash/codec/enc/jxl_enc.wasm'))});
    return {encode: (data, w, h) => api.encode(data, w, h, {...defaultOptions, quality, effort, lossless: quality === 100}),
      heap: () => api.HEAPU8.buffer.byteLength, close() {}};
  }
  if (codec === 'vips') {
    const {default: Vips} = await import(pathToFileURL(resolve(tools, 'vips/lib/vips-node.mjs')));
    const api = await Vips({dynamicLibraries: ['vips-jxl.wasm']});
    api.concurrency(1);
    api.Cache.max(0); // A queue of independent uploads must not retain previous operation graphs.
    return {encode(data, w, h) {
      const raw = api.Image.newFromMemory(data, w, h, 4, 'uchar');
      const image = raw.copy({interpretation: 'srgb'});
      try { return image.jxlsaveBuffer({Q: quality, effort, lossless: quality === 100, keep: 'none'}); }
      finally { image.delete(); raw.delete(); }
    }, close() { api.shutdown(); }};
  }
  throw new Error('Unknown codec: ' + codec);
}

if (!isMainThread) {
  const api = await encoder(workerData);
  parentPort.on('message', async ({data, width, height}) => {
    try {
      const bytes = new Uint8Array(await api.encode(data, width, height));
      parentPort.postMessage({bytes, heapBytes: api.heap?.() ?? null}, [bytes.buffer]);
    } catch (error) { parentPort.postMessage({error: {name: error.name, message: String(error.message), code: error.code}}); }
  });
  parentPort.postMessage({ready: true});
} else {
  const config = JSON.parse(process.argv[2]);
  const {width, height, rgba} = readPng(readFileSync(config.input));
  const inputHash = sha256(rgba), memoryBefore = process.memoryUsage();
  const t0 = performance.now();
  let encode, close, heap, initMs;
  if (config.execution === 'worker') {
    const worker = new Worker(new URL(import.meta.url), {workerData: config});
    await new Promise((resolve, reject) => { worker.once('error', reject); worker.once('message', m => m.ready ? resolve() : reject(new Error('Worker failed to initialize'))); });
    initMs = performance.now() - t0;
    encode = async () => {
      const pixels = new Uint8Array(rgba); // Required caller-owned copy included in round-trip timing.
      return new Promise((resolve, reject) => {
        worker.once('message', msg => msg.error ? reject(Object.assign(new Error(msg.error.message), msg.error)) : resolve(msg));
        worker.postMessage({data: pixels, width, height}, [pixels.buffer]);
      });
    };
    close = () => worker.terminate();
  } else {
    const api = await encoder(config); initMs = performance.now() - t0;
    encode = async () => ({bytes: new Uint8Array(await api.encode(rgba, width, height)), heapBytes: api.heap?.() ?? null, metadata: api.metadata?.()});
    close = () => api.close();
  }
  const times = []; let result, firstHash;
  for (let i = 0; i <= (config.repeats ?? 3); i++) {
    const start = performance.now(); result = await encode(); times.push(performance.now() - start);
    const outputHash = sha256(result.bytes);
    if (i === 0) firstHash = outputHash;
    else if (outputHash !== firstHash) throw new Error('Non-deterministic output between repeats');
  }
  if (sha256(rgba) !== inputHash) throw new Error('Encoder mutated input');
  const memory = {peakRSSKiB: process.resourceUsage().maxRSS, before: memoryBefore, after: process.memoryUsage(), wasmHeapBytes: result.heapBytes};
  writeFileSync(config.output, result.bytes);
  await close();
  console.log(JSON.stringify({codec: config.codec, quality: config.quality, effort: config.effort, maxError: config.maxError,
    execution: config.execution, width, height, inputHash, bytes: result.bytes.length, sha256: firstHash,
    initializationMs: initMs, coldMs: initMs + times[0], firstEncodeMs: times[0], warmMs: times.slice(1), memory, metadata: result.metadata,
    timing: config.execution === 'worker' ? 'Node worker_threads. Cold includes worker startup, module init and first copy/transfer/encode/reply. Warm includes caller-owned input copy, transfers and encode. Fixture decode excluded.'
      : 'Node main thread. Cold includes module import/initialization plus first encode. Warm excludes input PNG decode and output file write.',
    memoryMethod: 'Whole fresh Node process peak RSS (KiB), including decoded input, encoder, runtime and worker where used; not incremental codec allocation.',
    ...(config.codec === 'vips' ? {vips: {concurrency: 1, cacheMax: 0, dynamicLibraries: ['vips-jxl.wasm']}} : {})}));
  process.exit(0);
}
