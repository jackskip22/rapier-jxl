#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Complete lossless encoder, with only sampled split kernels ablated.
// Run sequentially on an otherwise idle, affinity-pinned host. No decoder runs here.
//
// node bench/sampled-kernels.mjs --corpus DIR --out NEW_DIR [--ids a,b --effort 9 --repeats 3 --quick]
// --quick runs each backend once for byte equality, with diagnostic timing only.
//
// The output directory must not already exist. Use separate fresh directories for
// selected IDs rather than mixing results from different source trees or options.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync} from 'node:fs';
import {arch, cpus, loadavg, platform, release} from 'node:os';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {createEncoder} from '../src/rapier.mjs';
import {configureKernels, kernelMode} from '../src/kernels.mjs';
import {kernelHooks} from '../src/kernel-hooks.mjs';
import {SCALAR, SIMD, SIMD_PROBE} from '../src/kernels-bytes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const BEFORE_PARTS = Object.freeze({channel: true, weighted: true, fill: true, screen: true, sampled: false});
const MODE_ORDER = ['before', 'after'];
const HASH = /^[0-9a-f]{64}$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const view = bytes => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const median = numbers => {
  const sorted = [...numbers].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length & 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function parse(argv) {
  const result = {corpus: null, out: null, ids: null, repeats: 3, effort: 9, quick: false};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log('Use --corpus DIR --out NEW_DIR [--ids comma,separated --effort 9 --repeats 3 --quick]. Effort is 1–9; --quick checks bytes without benchmark measurements. The corpus manifest is required; output must be fresh.');
      return null;
    }
    if (arg === '--quick') { result.quick = true; continue; }
    assert(['--corpus', '--out', '--ids', '--repeats', '--effort'].includes(arg), 'Unknown option: ' + arg);
    const value = argv[++i];
    assert(value && !value.startsWith('--'), 'Missing value for ' + arg);
    if (arg === '--ids') result.ids = value.split(',');
    else if (arg === '--repeats') result.repeats = Number(value);
    else if (arg === '--effort') result.effort = Number(value);
    else result[arg.slice(2)] = resolve(value);
  }
  assert(result.corpus && result.out, 'Use --corpus DIR --out NEW_DIR [--ids a,b --effort 9 --repeats 3 --quick]');
  assert(Number.isInteger(result.repeats) && result.repeats > 0, '--repeats must be a positive integer');
  assert(Number.isInteger(result.effort) && result.effort >= 1 && result.effort <= 9, '--effort must be an integer from 1 through 9');
  if (result.ids) assert(result.ids.length && result.ids.every(Boolean) && new Set(result.ids).size === result.ids.length, '--ids must contain unique nonempty IDs');
  return result;
}

function contained(root, file) {
  const name = relative(root, file);
  return !isAbsolute(name) && name !== '..' && !name.startsWith('..' + sep);
}

function moduleIdentity() {
  // All executable encoder modules, their readable WAT, and build/package identity.
  // The complete encoder's relative imports are all within this module directory.
  const files = readdirSync(ROOT).filter(name => /\.(mjs|wat)$/.test(name) || name === 'package.json').sort();
  const modules = Object.fromEntries(files.map(name => [name, sha256(readFileSync(join(ROOT, name)))]));
  modules['bench/sampled-kernels.mjs'] = sha256(readFileSync(fileURLToPath(import.meta.url)));
  modules['bench/corpus-sources.json'] = sha256(readFileSync(join(HERE, 'corpus-sources.json')));
  return {sha256: sha256(JSON.stringify(modules)), modules, wasm: {
    scalar: sha256(Buffer.from(SCALAR, 'base64')),
    simd: sha256(Buffer.from(SIMD, 'base64')),
    probe: sha256(Buffer.from(SIMD_PROBE, 'base64')),
  }};
}

function environment() {
  let affinity = null;
  try { affinity = readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1] ?? null; } catch { /* Non-Linux host. */ }
  const processors = cpus();
  return {node: process.version, versions: {...process.versions}, platform: platform(), arch: arch(), release: release(),
    cpu: processors[0]?.model ?? null, logicalCpus: processors.length, affinity, execArgv: [...process.execArgv],
    nodeOptions: process.env.NODE_OPTIONS || '', gcAvailable: typeof globalThis.gc === 'function', explicitGc: false,
    helperWorkers: 0, callingThreads: 1, initialLoadavg: loadavg()};
}

function configure(mode) {
  const expected = mode === 'off' ? 'off' : mode === 'scalar' ? 'scalar' : 'simd';
  assert.equal(configureKernels(expected, mode === 'before' ? BEFORE_PARTS : undefined), expected, 'Requested backend did not initialize: ' + mode);
  assert.equal(kernelMode(), expected);
  for (const name of ['channel', 'weighted', 'fill', 'screen']) {
    assert.equal(typeof kernelHooks[name], mode === 'off' ? 'object' : 'function', mode + ': ' + name + ' hook');
    if (mode === 'off') assert.equal(kernelHooks[name], null);
  }
  const sampledEnabled = mode === 'after' || mode === 'scalar';
  const real = kernelHooks.sampled;
  if (sampledEnabled) assert.equal(typeof real, 'function', mode + ': sampled hook must run');
  else assert.equal(real, null, mode + ': sampled hook must be disabled');
  const tally = {enabled: sampledEnabled, calls: 0, took: 0, declined: 0, returnedProposal: 0, maxMembers: 0};
  if (sampledEnabled) kernelHooks.sampled = (...args) => {
    const result = real(...args);
    tally.calls++;
    if (result === false) tally.declined++; else tally.took++;
    if (result && result !== false) tally.returnedProposal++;
    if (args[0].length > tally.maxMembers) tally.maxMembers = args[0].length;
    return result;
  };
  return {backend: expected, tally};
}

async function main() {
  const args = parse(process.argv.slice(2));
  if (!args) return;
  const options = Object.freeze({lossless: true, effort: args.effort});
  const repeats = args.quick ? 0 : args.repeats;
  const corpus = realpathSync(args.corpus), manifestFile = join(corpus, 'manifest.json');
  const manifestBytes = readFileSync(manifestFile), manifest = JSON.parse(manifestBytes);
  assert(Array.isArray(manifest) && manifest.length > 0, 'A nonempty corpus manifest is required');
  assert.equal(new Set(manifest.map(row => row.id)).size, manifest.length, 'Manifest IDs must be unique');
  for (const item of manifest) {
    assert(typeof item.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(item.id), 'Unsafe or missing image ID');
    assert(Number.isSafeInteger(item.width) && item.width > 0 && Number.isSafeInteger(item.height) && item.height > 0 &&
      Number.isSafeInteger(item.width * item.height * 4), item.id + ': invalid dimensions');
    assert(typeof item.pixels === 'string' && !isAbsolute(item.pixels) && contained(corpus, resolve(corpus, item.pixels)), item.id + ': pixels must be inside corpus');
    assert(HASH.test(item.rgbaHash), item.id + ': missing SHA-256 of raw RGBA');
    if (item.sourceSha256 !== undefined) assert(HASH.test(item.sourceSha256), item.id + ': invalid original-source hash');
  }
  if (args.ids) for (const id of args.ids) assert(manifest.some(row => row.id === id), 'Unknown image ID: ' + id);
  const selected = manifest.filter(row => !args.ids || args.ids.includes(row.id));
  assert(selected.length, 'No images selected');
  assert(!existsSync(args.out), 'Output already exists; use a fresh directory to prevent stale or mixed receipts');
  assert(!contained(corpus, args.out), 'Output must not be inside the read-only input corpus');
  let existingParent = dirname(args.out);
  while (!existsSync(existingParent)) existingParent = dirname(existingParent);
  assert(!contained(corpus, realpathSync(existingParent)), 'Output ancestor resolves inside the read-only corpus');
  mkdirSync(dirname(args.out), {recursive: true});
  assert(!contained(corpus, realpathSync(dirname(args.out))), 'Output parent resolves inside the read-only corpus');
  mkdirSync(args.out); mkdirSync(join(args.out, 'jxl'));
  const identity = moduleIdentity(), runtime = environment();
  const method = {
    encoder: '../src/rapier.mjs createEncoder(), one persistent complete encoder, no helper workers',
    before: {backend: 'simd', parts: BEFORE_PARTS}, after: {backend: 'simd', parts: 'all'},
    initialization: 'One untimed 1x1 lossless effort-1 encode initializes the lazy factory before any per-run backend configuration.',
    firstCalls: args.quick
      ? 'One before, after, off and scalar encode per image. No image warmups or measured repeats. First-call timings are diagnostic only, not benchmark evidence.'
      : 'One first-call encode per image/mode, then one additional warmup each. First-call is not a fresh process or cold engine.',
    measured: args.quick
      ? 'None. Quick byte-equality mode does not report benchmark speedups.'
      : 'Before/after pairs alternate first position by manifest index and repeat; each mode has the requested repeat count.',
    equality: 'Every corpus encode, including first calls, warmups, measured calls, off and scalar, is compared byte-for-byte with the first before stream. RGBA is compared byte-for-byte after every call.',
    timing: 'Wall and process user+system CPU around complete codec.encode only, including admission, search, promise steps and output production; excludes loading, hashing, byte checks, mode configuration, filesystem and decoding. Node-level sampled-call counters run inside timing.',
    confirmation: 'Once per image, off and scalar are compared to the same reference. No decoder is run here; independent stock-decoder audit is required separately.',
    resume: 'Disabled. Every invocation requires a new output directory. Selected IDs permit independent, source-bound shards.',
  };
  const environmentFile = {schema: 1, experiment: 'sampled-kernels', createdAt: new Date().toISOString(), environment: runtime, identity,
    corpus: {manifestSha256: sha256(manifestBytes), totalImages: manifest.length, selectedIds: selected.map(row => row.id)},
    options, quick: args.quick, benchmark: !args.quick, repeats, method};
  const environmentText = json(environmentFile), environmentSha256 = sha256(environmentText);
  writeFileSync(join(args.out, 'environment.json'), environmentText, {flag: 'wx'});
  writeFileSync(join(args.out, 'results.jsonl'), '', {flag: 'wx'});
  const receipt = {schema: 1, experiment: 'sampled-kernels', complete: false, startedAt: environmentFile.createdAt,
    environmentSha256, codeSha256: identity.sha256, manifestSha256: environmentFile.corpus.manifestSha256,
    options, quick: args.quick, benchmark: !args.quick, repeats, selectedIds: selected.map(row => row.id), completedIds: [], current: null,
    decoderAudit: {performed: false, required: 'Decode the saved after streams independently and compare all source RGBA bytes, including hidden RGB.'}};
  const saveReceipt = () => {
    writeFileSync(join(args.out, 'receipt.json.tmp'), json(receipt));
    renameSync(join(args.out, 'receipt.json.tmp'), join(args.out, 'receipt.json'));
  };
  saveReceipt();
  try {
    // createJPEGXLEncoder configures automatic kernels at first use. Initialize it
    // here so that it cannot undo the per-run ablation inside the first timed call.
    assert(!(typeof globalThis.Worker === 'function' && typeof globalThis.location === 'object' && globalThis.location?.href), 'This harness must run without automatic helper workers');
    const codec = createEncoder();
    const tiny = Uint8Array.of(7, 13, 23, 255), tinyBefore = Buffer.from(tiny);
    const factoryStart = performance.now();
    await codec.encode({data: tiny, width: 1, height: 1}, {lossless: true, effort: 1});
    assert(view(tiny).equals(tinyBefore), 'Factory initialization changed its input');
    receipt.factoryInitializationMs = performance.now() - factoryStart;
    // Fail before a costly image if SIMD is unavailable; never label JS as SIMD.
    configure('before'); configure('after'); configure('scalar'); configure('off');
    for (const item of selected) {
      const manifestIndex = manifest.indexOf(item), startedAt = new Date().toISOString();
      receipt.current = {id: item.id, phase: 'loading'}; saveReceipt();
      const path = realpathSync(resolve(corpus, item.pixels));
      assert(contained(corpus, path), item.id + ': pixel symlink resolves outside corpus');
      const rgba = new Uint8Array(readFileSync(path)), original = Buffer.from(rgba);
      assert.equal(rgba.length, item.width * item.height * 4, item.id + ': RGBA byte count');
      assert.equal(sha256(rgba), item.rgbaHash, item.id + ': input RGBA hash mismatch');
      const input = {data: rgba, width: item.width, height: item.height};
      const runs = [], initialLoad = loadavg();
      let reference, expectedSha256, savedAfter;
      const run = async (mode, phase, repeat) => {
        receipt.current = {id: item.id, mode, phase, repeat}; saveReceipt();
        const {backend, tally} = configure(mode), loadBefore = loadavg();
        const cpuStart = process.cpuUsage(), wallStart = performance.now();
        const bytes = await codec.encode(input, options);
        const wallMs = performance.now() - wallStart, cpu = process.cpuUsage(cpuStart);
        assert(bytes instanceof Uint8Array && bytes.length, item.id + ': encoder returned no byte stream');
        assert.equal(kernelMode(), backend, item.id + ': backend changed during encode');
        assert(view(rgba).equals(original), item.id + '/' + mode + '/' + phase + ': source RGBA changed');
        if (!reference) {
          assert.equal(mode, 'before', 'Reference must come from the sampled-disabled production path');
          reference = Buffer.from(bytes); expectedSha256 = sha256(reference);
        } else assert(view(bytes).equals(reference), item.id + '/' + mode + '/' + phase + ': output bytes differ from before');
        const outputSha256 = sha256(bytes);
        assert.equal(outputSha256, expectedSha256);
        if (mode === 'after' && (phase === 'measured' || args.quick && phase === 'first') && !savedAfter) savedAfter = Buffer.from(bytes);
        const sample = {mode, backend, phase, repeat, wallMs, cpuMs: (cpu.user + cpu.system) / 1000,
          cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000, bytes: bytes.length, sha256: outputSha256,
          diagnosticOnly: phase !== 'measured', equalToBefore: true, sourceUnchanged: true, sampled: {...tally}, loadBefore};
        runs.push(sample);
        return sample;
      };
      // Before must establish the reference; first calls are separately reported.
      await run('before', 'first', 0); await run('after', 'first', 0);
      if (!args.quick) {
        for (const mode of manifestIndex & 1 ? ['after', 'before'] : MODE_ORDER) await run(mode, 'warmup', 0);
        for (let repeat = 0; repeat < repeats; repeat++) {
          const order = (manifestIndex + repeat) & 1 ? ['after', 'before'] : MODE_ORDER;
          for (const mode of order) await run(mode, 'measured', repeat);
        }
      }
      await run('off', 'equality', 0); await run('scalar', 'equality', 0);
      const byMode = Object.fromEntries(['before', 'after', 'off', 'scalar'].map(mode => {
        const all = runs.filter(row => row.mode === mode), timed = all.filter(row => row.phase === 'measured');
        const sampled = all.reduce((sum, row) => ({enabled: row.sampled.enabled, calls: sum.calls + row.sampled.calls,
          took: sum.took + row.sampled.took, declined: sum.declined + row.sampled.declined,
          returnedProposal: sum.returnedProposal + row.sampled.returnedProposal,
          maxMembers: Math.max(sum.maxMembers, row.sampled.maxMembers)}), {enabled: false, calls: 0, took: 0, declined: 0, returnedProposal: 0, maxMembers: 0});
        return [mode, {sampled, measuredCalls: timed.length, diagnosticFirstWallMs: all.find(row => row.phase === 'first')?.wallMs ?? null,
          medianWallMs: timed.length ? median(timed.map(row => row.wallMs)) : null,
          medianCpuMs: timed.length ? median(timed.map(row => row.cpuMs)) : null}];
      }));
      // Palette/early-exit images legitimately do no sampled work. If after calls
      // the hook, however, neither accelerated path may silently decline it all.
      const sampledPath = byMode.after.sampled.calls > 0;
      if (sampledPath) {
        assert(byMode.after.sampled.took > 0, item.id + ': after never accepted sampled work');
        assert(byMode.scalar.sampled.took > 0, item.id + ': scalar never accepted sampled work');
      }
      assert(savedAfter && savedAfter.equals(reference));
      const output = 'jxl/' + item.id + '-e' + args.effort + '.jxl';
      writeFileSync(join(args.out, output), savedAfter, {flag: 'wx'});
      const row = {schema: 1, experiment: 'sampled-kernels', id: item.id, image: item.id, kind: item.kind, group: item.group,
        width: item.width, height: item.height, effort: args.effort, options, quick: args.quick, benchmark: !args.quick, repeats, rgbaHash: item.rgbaHash,
        source: item.source ?? null, sourceSha256: item.sourceSha256 ?? null,
        derivedFrom: item.derivedFrom ?? null, recipe: item.recipe ?? null,
        pixels: item.pixels, alpha: item.alpha ?? null, hiddenRgbPixels: item.hiddenRgbPixels ?? null,
        bytes: reference.length, sha256: expectedSha256, output, equalAcrossAllCalls: true, sourceUnchanged: true,
        sampledPath, summary: byMode, wallSpeedup: args.quick ? null : byMode.before.medianWallMs / byMode.after.medianWallMs,
        cpuSpeedup: !args.quick && byMode.after.medianCpuMs ? byMode.before.medianCpuMs / byMode.after.medianCpuMs : null,
        diagnosticFirstWallRatio: byMode.after.diagnosticFirstWallMs ? byMode.before.diagnosticFirstWallMs / byMode.after.diagnosticFirstWallMs : null,
        runs, startedAt, finishedAt: new Date().toISOString(),
        environment: {sha256: environmentSha256, node: runtime.node, cpu: runtime.cpu, affinity: runtime.affinity,
          initialLoadavg: initialLoad, finalLoadavg: loadavg()},
        codeSha256: identity.sha256, manifestSha256: environmentFile.corpus.manifestSha256, decoderVerified: false};
      appendFileSync(join(args.out, 'results.jsonl'), JSON.stringify(row) + '\n');
      receipt.completedIds.push(item.id); receipt.current = null; saveReceipt();
      console.log(JSON.stringify({id: item.id, effort: args.effort, quick: args.quick, bytes: row.bytes, sha256: row.sha256, sampledPath,
        ...(args.quick ? {diagnosticFirstWallRatio: row.diagnosticFirstWallRatio}
          : {beforeMs: byMode.before.medianWallMs, afterMs: byMode.after.medianWallMs, speedup: row.wallSpeedup})}));
    }
    assert.equal(moduleIdentity().sha256, identity.sha256, 'Encoder or harness sources changed during the run; discard these timing results');
    assert.equal(sha256(readFileSync(manifestFile)), environmentFile.corpus.manifestSha256, 'Corpus manifest changed during the run');
    receipt.complete = true; receipt.finishedAt = new Date().toISOString(); receipt.sourcesStable = true; saveReceipt();
  } catch (error) {
    receipt.error = {name: error.name, message: error.message, stack: error.stack};
    receipt.failedAt = new Date().toISOString(); saveReceipt();
    throw error;
  } finally { configureKernels('off'); }
}

await main();
