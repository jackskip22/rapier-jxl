#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Benchmark and conformance harness: Rapier against libjxl on a corpus built by corpus.mjs.
//
// For every image it encodes losslessly with Rapier at the chosen efforts and with libjxl at the same efforts, then
// lossily with Rapier at the chosen qualities and with libjxl at the matching distance and at a distance that matches
// Rapier's byte count. It records bytes, bits per pixel and median encode time (wall and CPU, after warmup), decodes
// every Rapier output with djxl and jxl-oxide, and checks it: lossless output must equal the source pixels, including
// colour under zero alpha; lossy output must decode in both decoders, agree within one level, and keep alpha exact.
// Lossy output is scored with ssimulacra2 and butteraugli on opaque images.
//
//   taskset -c 3 node --expose-gc bench/compare.mjs --corpus DIR --out DIR --libjxl-tools DIR --oxide PATH --helper PATH
//
// --rapier-before PATH adds a second Rapier build (codec rapier-before) to the alternating runs of every lossless setting.
// --max-load N waits for the one-minute load average to fall to N before each timed lossless setting; every row records
// the load average, and Rapier and libjxl runs alternate within a setting so that both see the same conditions.
// --quick encodes each Rapier setting once (no timing) to compare output bytes between two builds of the encoder;
// --no-libjxl leaves out the libjxl encodes (lossless rows).
//
// Rows are appended to results.jsonl as they finish; an interrupted run resumes where it stopped.
import {execFile} from 'node:child_process';
import {appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {cpus, loadavg, release} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {LibjxlHelper} from './libjxl-client.mjs';
import {readPng, sha256} from './image-io.mjs';

const run = promisify(execFile), here = dirname(fileURLToPath(import.meta.url));

function parse(argv) {
  const o = {corpus: null, out: null, tools: process.env.JXL_BENCH_LIBJXL_TOOLS, oxide: process.env.JXL_BENCH_OXIDE, helper: process.env.JXL_BENCH_HELPER,
    rapier: resolve(here, '../src/rapier.mjs'), before: null, label: 'run', groups: null, ids: null, efforts: [1, 3, 7, 9], qualities: [90, 75, 50], libjxlExtra: [], lossless: true, lossy: true,
    decode: true, quick: false, libjxl: true, maxLoad: Infinity, loadWaitSeconds: 1200, warmups: 1, warmupSeconds: 2, maxRepeats: 5, budget: 90, force: false, matchTolerance: 0.01};
  const list = value => value.split(',').filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--corpus') o.corpus = resolve(next()); else if (a === '--out') o.out = resolve(next()); else if (a === '--libjxl-tools') o.tools = resolve(next());
    else if (a === '--oxide') o.oxide = resolve(next()); else if (a === '--helper') o.helper = resolve(next()); else if (a === '--rapier') o.rapier = resolve(next()); else if (a === '--rapier-before') o.before = resolve(next());
    else if (a === '--label') o.label = next(); else if (a === '--groups') o.groups = list(next()); else if (a === '--ids') o.ids = list(next());
    else if (a === '--efforts') o.efforts = list(next()).map(Number); else if (a === '--qualities') o.qualities = list(next()).map(Number);
    else if (a === '--libjxl-extra-efforts') o.libjxlExtra = list(next()).map(Number);
    else if (a === '--warmups') o.warmups = Number(next()); else if (a === '--warmup-seconds') o.warmupSeconds = Number(next()); else if (a === '--max-repeats') o.maxRepeats = Number(next()); else if (a === '--budget-seconds') o.budget = Number(next());
    else if (a === '--no-lossless') o.lossless = false; else if (a === '--no-lossy') o.lossy = false; else if (a === '--no-decode') o.decode = false;
    else if (a === '--force') o.force = true; else if (a === '--quick') o.quick = true; else if (a === '--no-libjxl') o.libjxl = false; else if (a === '--max-load') o.maxLoad = Number(next()); else if (a === '--load-wait-seconds') o.loadWaitSeconds = Number(next());
    else throw new Error('Unknown option ' + a);
  }
  for (const k of ['corpus', 'out', 'tools', 'oxide', 'helper']) if (!o[k]) throw new Error('Missing --' + (k === 'tools' ? 'libjxl-tools' : k) + ' (see the header of compare.mjs)');
  return o;
}

// libjxl's JxlEncoderDistanceFromQuality, the mapping Rapier's quality follows.
const distanceFromQuality = q => q >= 100 ? 0 : q >= 30 ? 0.1 + (100 - q) * 0.09 : 53 / 3000 * q * q - 23 / 20 * q + 25;
const median = values => { const s = [...values].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

async function version(binary, args) {
  try { const r = await run(binary, args, {encoding: 'utf8'}); return (r.stdout + r.stderr).trim().split('\n')[0]; } catch (error) { return 'unavailable: ' + error.message.split('\n')[0]; }
}

// Decode with one command-line decoder. Returns {ok, ms, rgba?, error?}.
async function decodeWith(decoder, jxl, scratch) {
  const input = join(scratch, 'in.jxl'), output = join(scratch, decoder.name + '.png');
  writeFileSync(input, jxl);
  const started = performance.now();
  try {
    await run(decoder.path, decoder.args(input, output), {encoding: 'utf8', timeout: 600000, maxBuffer: 1 << 24});
    const ms = performance.now() - started, image = readPng(readFileSync(output));
    return {ok: true, ms, image};
  } catch (error) { return {ok: false, ms: performance.now() - started, error: String(error.stderr || error.message).slice(0, 600)}; }
}

// Compare decoded straight RGBA with the source. Returns {pixels, maxDiff, alphaDiff, hiddenDiff}.
function difference(source, decoded) {
  const a = source.rgba, b = decoded.rgba;
  if (decoded.width !== source.width || decoded.height !== source.height) return {size: false};
  let pixels = 0, maxDiff = 0, alphaDiff = 0, hiddenDiff = 0;
  for (let i = 0; i < a.length; i += 4) {
    let bad = false;
    for (let k = 0; k < 4; k++) {
      const d = Math.abs(a[i + k] - b[i + k]);
      if (d) { bad = true; if (k < 3) { if (d > maxDiff) maxDiff = d; } else alphaDiff++; }
    }
    if (bad) { pixels++; if (a[i + 3] === 0) hiddenDiff++; }
  }
  return {size: true, pixels, maxDiff, alphaDiff, hiddenDiff};
}
function between(a, b) {  // largest per-sample difference between two decodings
  let max = 0;
  for (let i = 0; i < a.rgba.length; i++) { const d = Math.abs(a.rgba[i] - b.rgba[i]); if (d > max) max = d; }
  return max;
}

async function metric(tool, args) {
  try { const r = await run(tool, args, {encoding: 'utf8', timeout: 900000}); return parseFloat(r.stdout.trim().split(/\s+/)[0]); } catch { return null; }
}

async function main() {
  const o = parse(process.argv.slice(2));
  mkdirSync(join(o.out, 'jxl'), {recursive: true});
  const scratch = join(o.out, 'scratch'); mkdirSync(scratch, {recursive: true});
  const tools = {cjxl: join(o.tools, 'cjxl'), djxl: join(o.tools, 'djxl'), ssimulacra2: join(o.tools, 'ssimulacra2'), butteraugli: join(o.tools, 'butteraugli_main')};
  const helperEnv = {...process.env, LD_LIBRARY_PATH: process.env.JXL_BENCH_LIBRARY_PATH || process.env.LD_LIBRARY_PATH || ''};
  const decoders = [
    {name: 'djxl', path: tools.djxl, args: (i, out) => [i, out, '--num_threads=1', '--bits_per_sample=8', '--quiet']},
    {name: 'oxide', path: o.oxide, args: (i, out) => [i, '-o', out, '-f', 'png8']},
  ];
  const manifest = JSON.parse(readFileSync(join(o.corpus, 'manifest.json'), 'utf8'))
    .filter(r => (!o.groups || o.groups.includes(r.group)) && (!o.ids || o.ids.includes(r.id)));
  if (!manifest.length) throw new Error('No corpus images selected');
  const rapierModule = await import(pathToFileURL(o.rapier).href), rapier = rapierModule.createEncoder();
  const earlier = o.before ? (await import(pathToFileURL(o.before).href)).createEncoder() : null;
  const helper = new LibjxlHelper(o.helper, {env: helperEnv}), helperVersion = await helper.start();
  const resultsFile = join(o.out, 'results.jsonl'), failuresFile = join(o.out, 'failures.jsonl');
  const done = new Set(existsSync(resultsFile) && !o.force ? readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean).map(l => { const r = JSON.parse(l); return r.codec + '|' + r.image + '|' + r.tag; }) : []);
  const environment = {
    started: new Date().toISOString(), label: o.label, node: process.version, platform: process.platform, arch: process.arch, release: release(), cpu: cpus()[0]?.model, cores: cpus().length,
    affinity: readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1], gc: typeof globalThis.gc === 'function', loadavg: loadavg(),
    rapier: {entry: o.rapier, sourceSha256: sha256(readFileSync(o.rapier))}, before: o.before ? {entry: o.before, sourceSha256: sha256(readFileSync(o.before))} : null,
    tools: {cjxl: await version(tools.cjxl, ['--version']), djxl: await version(tools.djxl, ['--version']), oxide: await version(o.oxide, ['--version']), ssimulacra2: tools.ssimulacra2, butteraugli: tools.butteraugli, helper: helperVersion},
    options: {efforts: o.efforts, qualities: o.qualities, libjxlExtra: o.libjxlExtra, warmups: o.warmups, warmupSeconds: o.warmupSeconds, maxRepeats: o.maxRepeats, budgetSeconds: o.budget},
    method: 'One process, one calling thread, sequential. Rapier is timed in-process through the complete encoder (createEncoder); libjxl through a persistent helper that creates a fresh single-threaded encoder per call. Encode time excludes input loading and decoding. The first run is a cold call and is recorded separately; warmup runs follow until the engine has compiled the hot loops (about two seconds of runs, at most 25), then timing; the number of timed runs shrinks as a run gets longer so that every setting takes about the budget.',
  };
  writeFileSync(join(o.out, 'environment.json'), JSON.stringify(environment, null, 2) + '\n');
  const failures = [];
  const record = row => { appendFileSync(resultsFile, JSON.stringify(row) + '\n'); done.add(row.codec + '|' + row.image + '|' + row.tag); };
  const fail = (row, what, detail) => { const f = {image: row.image, tag: row.tag, codec: row.codec, what, detail}; failures.push(f); appendFileSync(failuresFile, JSON.stringify(f) + '\n'); console.error('FAILURE', JSON.stringify(f)); };
  const wanted = (codec, id, tag) => o.force || !done.has(codec + '|' + id + '|' + tag);

  // With --max-load, wait until the one-minute load average is at or below the limit, for at most --load-wait-seconds in all
  // (a machine that never calms is measured anyway); each row records whether the load was within the limit.
  let waitedMs = 0, quiet = true;
  async function calm() {
    while (loadavg()[0] > o.maxLoad && waitedMs < o.loadWaitSeconds * 1000) { await new Promise(done => setTimeout(done, 5000)); waitedMs += 5000; }
    quiet = loadavg()[0] <= o.maxLoad;
  }

  // Timed Rapier encode: one warmup (its output is the checked output), then as many timed runs as the budget allows.
  async function timeRapier(image, options) {
    const input = {width: image.width, height: image.height, data: image.rgba};
    globalThis.gc?.();
    let t = performance.now(), cpu = process.cpuUsage();
    let bytes = await rapier.encode(input, options);
    const first = {ms: performance.now() - t, cpuMs: (u => (u.user + u.system) / 1000)(process.cpuUsage(cpu))};
    const hash = sha256(bytes);
    // --quick keeps the first run as the only sample: bytes and conformance, not a timing.
    if (o.quick) return {bytes, hash, ms: first.ms, cpuMs: first.cpuMs, msSamples: [first.ms], cpuSamples: [first.cpuMs], firstMs: first.ms, reps: 0};
    // A short encode needs many warmup runs before the engine has compiled its hot loops; a long one needs none.
    const warmups = Math.min(25, Math.max(o.warmups, Math.ceil(o.warmupSeconds * 1000 / first.ms)));
    for (let i = 1; i < warmups; i++) { globalThis.gc?.(); await rapier.encode(input, options); }
    const repeats = Math.max(1, Math.min(o.maxRepeats, Math.floor(o.budget * 1000 / first.ms)));
    const wall = [], cpuTimes = [];
    for (let i = 0; i < repeats; i++) {
      globalThis.gc?.();
      t = performance.now(); cpu = process.cpuUsage();
      const again = await rapier.encode(input, options);
      wall.push(performance.now() - t); const u = process.cpuUsage(cpu); cpuTimes.push((u.user + u.system) / 1000);
      if (sha256(again) !== hash) throw new Error('Rapier output is not deterministic for ' + JSON.stringify(options));
    }
    return {bytes, hash, ms: median(wall), cpuMs: median(cpuTimes), msSamples: wall, cpuSamples: cpuTimes, firstMs: first.ms, reps: repeats};
  }

  // Decode a Rapier output with both decoders and judge it. Returns {djxl, oxide, ...} fields for the row.
  async function judge(row, source, bytes, lossless, keepDecoded) {
    const result = {}; const images = {};
    for (const decoder of decoders) {
      const d = await decodeWith(decoder, bytes, scratch);
      if (!d.ok) { result[decoder.name] = {ok: false, error: d.error}; fail(row, decoder.name + ' refused the stream', d.error); continue; }
      images[decoder.name] = d.image;
      const diff = difference(source, d.image);
      const entry = {ok: true, ms: d.ms, ...diff};
      if (!diff.size) { entry.ok = false; fail(row, decoder.name + ' returned other dimensions', `${d.image.width}x${d.image.height}`); }
      else if (lossless && (diff.pixels || diff.alphaDiff)) { entry.ok = false; fail(row, decoder.name + ' changed lossless pixels', JSON.stringify(diff)); }
      else if (!lossless && diff.alphaDiff) { entry.ok = false; fail(row, decoder.name + ' changed alpha', JSON.stringify(diff)); }
      result[decoder.name] = entry;
    }
    if (images.djxl && images.oxide && !lossless) {
      result.betweenDecoders = between(images.djxl, images.oxide);
      if (result.betweenDecoders > 1) fail(row, 'decoders differ by more than one level', String(result.betweenDecoders));
    }
    return {result, djxlImage: images.djxl};
  }

  async function scoreLossy(source, record_, decodedPng) {
    const png = join(o.corpus, source.png);
    return {ssimulacra2: await metric(tools.ssimulacra2, [png, decodedPng]), butteraugli: await metric(tools.butteraugli, [png, decodedPng])};
  }

  for (const entry of manifest) {
    const rgba = new Uint8Array(readFileSync(join(o.corpus, entry.pixels)));
    if (sha256(rgba) !== entry.rgbaHash) throw new Error(entry.id + ' pixels do not match the manifest');
    const image = {width: entry.width, height: entry.height, rgba, png: entry.png};
    const base = {image: entry.id, group: entry.group, width: entry.width, height: entry.height, alpha: entry.alpha, hiddenRgbPixels: entry.hiddenRgbPixels};
    const opaque = entry.alpha === 'opaque';
    console.log('==', entry.id, entry.width + 'x' + entry.height, entry.group);

    if (o.lossless) for (const effort of [...new Set([...o.efforts, ...o.libjxlExtra])]) {
      const tag = 'e' + effort, wantR = o.efforts.includes(effort) && wanted('rapier', entry.id, tag), wantL = o.libjxl && wanted('libjxl', entry.id, tag);
      const wantB = Boolean(earlier) && o.efforts.includes(effort) && wanted('rapier-before', entry.id, tag);
      if (!wantR && !wantL && !wantB) continue;
      // Both encoders are measured in the same window: a cold call each, then alternating timed runs, so that a change in
      // machine load between runs reaches Rapier and libjxl alike.
      const options = {lossless: true, effort}, input = {width: entry.width, height: entry.height, data: rgba};
      const timed = async fn => { globalThis.gc?.(); const c = process.cpuUsage(), t = performance.now(); const value = await fn(); const u = process.cpuUsage(c); return {value, ms: performance.now() - t, cpuMs: (u.user + u.system) / 1000}; };
      let R = null, L = null, B = null;
      if (wantB) { const first = await timed(() => earlier.encode(input, options)); B = {bytes: first.value, hash: sha256(first.value), first, wall: [], cpu: []}; }
      if (wantR) { const first = await timed(() => rapier.encode(input, options)); R = {bytes: first.value, hash: sha256(first.value), first, wall: [], cpu: []}; }
      if (wantL) {
        const first = await helper.encode({width: entry.width, height: entry.height, rgba, effort, distance: 0, warmups: 0, repeats: 1});
        L = {bytes: first.bytes, meta: first.meta, first: {ms: first.meta.medianMs, cpuMs: first.meta.medianCpuMs}, wall: [], cpu: []};
      }
      const slowest = Math.max(R?.first.ms ?? 0, L?.first.ms ?? 0, B?.first.ms ?? 0);
      let repeats = 0;
      if (!o.quick) {
        repeats = Math.max(1, Math.min(o.maxRepeats, Math.floor(o.budget * 1000 / slowest)));
        // A short Rapier encode needs many warmup runs before the engine has compiled its hot loops; a long one needs none.
        const warmups = R || B ? Math.min(25, Math.max(o.warmups, Math.ceil(o.warmupSeconds * 1000 / (R || B).first.ms))) : 0;
        for (let i = 1; i < warmups; i++) { if (R) await timed(() => rapier.encode(input, options)); if (B) await timed(() => earlier.encode(input, options)); }
        if (L) await helper.encode({width: entry.width, height: entry.height, rgba, effort, distance: 0, warmups: 1, repeats: 1});
        await calm();
        for (let i = 0; i < repeats; i++) {
          if (B) { const r = await timed(() => earlier.encode(input, options)); B.wall.push(r.ms); B.cpu.push(r.cpuMs); if (sha256(r.value) !== B.hash) throw new Error('The earlier Rapier build is not deterministic for ' + JSON.stringify(options)); }
          if (R) { const r = await timed(() => rapier.encode(input, options)); R.wall.push(r.ms); R.cpu.push(r.cpuMs); if (sha256(r.value) !== R.hash) throw new Error('Rapier output is not deterministic for ' + JSON.stringify(options)); }
          if (L) { const r = await helper.encode({width: entry.width, height: entry.height, rgba, effort, distance: 0, warmups: 0, repeats: 1}); L.wall.push(r.meta.medianMs); L.cpu.push(r.meta.medianCpuMs); }
        }
      } else { if (B) { B.wall.push(B.first.ms); B.cpu.push(B.first.cpuMs); } if (R) { R.wall.push(R.first.ms); R.cpu.push(R.first.cpuMs); } if (L) { L.wall.push(L.first.ms); L.cpu.push(L.first.cpuMs); } }
      const load = loadavg()[0];
      if (B) {
        const row = {codec: 'rapier-before', ...base, mode: 'lossless', tag, effort, label: o.label, bytes: B.bytes.length, bpp: B.bytes.length * 8 / (entry.width * entry.height), sha256: B.hash,
          ms: median(B.wall), cpuMs: median(B.cpu), msSamples: B.wall, cpuSamples: B.cpu, firstMs: B.first.ms, reps: repeats, loadavg: load, quiet};
        record(row); console.log('  before', tag, row.bytes, 'B', row.ms.toFixed(0), 'ms', row.reps + ' runs');
      }
      if (R) {
        const row = {codec: 'rapier', ...base, mode: 'lossless', tag, effort, label: o.label, bytes: R.bytes.length, bpp: R.bytes.length * 8 / (entry.width * entry.height), sha256: R.hash,
          ms: median(R.wall), cpuMs: median(R.cpu), msSamples: R.wall, cpuSamples: R.cpu, firstMs: R.first.ms, reps: repeats, loadavg: load, quiet};
        writeFileSync(join(o.out, 'jxl', entry.id + '.rapier.' + tag + '.jxl'), R.bytes);
        if (o.decode) Object.assign(row, (await judge(row, image, R.bytes, true)).result);
        record(row); console.log('  rapier', tag, row.bytes, 'B', row.ms.toFixed(0), 'ms', row.reps + ' runs', row.djxl?.ok && row.oxide?.ok ? 'exact in djxl and oxide' : o.decode ? 'DECODE FAILURE' : '');
      }
      if (L) {
        const row = {codec: 'libjxl', ...base, mode: 'lossless', tag, effort, label: o.label, bytes: L.meta.bytes, bpp: L.meta.bytes * 8 / (entry.width * entry.height), sha256: sha256(L.bytes),
          ms: median(L.wall), cpuMs: median(L.cpu), msSamples: L.wall, cpuSamples: L.cpu, firstMs: L.first.ms, reps: repeats, alphaCoded: L.meta.alphaCoded, loadavg: load, quiet};
        writeFileSync(join(o.out, 'jxl', entry.id + '.libjxl.' + tag + '.jxl'), L.bytes);
        record(row); console.log('  libjxl', tag, row.bytes, 'B', row.ms.toFixed(1), 'ms', row.reps + ' runs');
      }
    }

    if (o.lossy) for (const quality of o.qualities) {
      const tag = 'photo-q' + quality;
      if (wanted('rapier', entry.id, tag)) {
        const row = {codec: 'rapier', ...base, mode: 'lossy', tag, quality, photo: true, label: o.label};
        const t = await timeRapier(image, {quality, photo: true});
        Object.assign(row, {bytes: t.bytes.length, bpp: t.bytes.length * 8 / (entry.width * entry.height), sha256: t.hash, ms: t.ms, cpuMs: t.cpuMs, msSamples: t.msSamples, cpuSamples: t.cpuSamples, firstMs: t.firstMs, reps: t.reps, loadavg: loadavg()[0]});
        writeFileSync(join(o.out, 'jxl', entry.id + '.rapier.' + tag + '.jxl'), t.bytes);
        let decoded = null;
        if (o.decode) { const j = await judge(row, image, t.bytes, false); Object.assign(row, j.result); decoded = j.djxlImage; }
        // A palette picture whose lossy attempt cannot beat the exact result comes back exact; it is not a lossy sample.
        row.exact = Boolean(row.djxl?.ok && row.djxl.pixels === 0 && row.djxl.alphaDiff === 0);
        if (decoded && opaque && !row.exact) row.metrics = await scoreLossy(image, row, join(scratch, 'djxl.png'));
        record(row); console.log('  rapier', tag, row.bytes, 'B', row.ms.toFixed(0), 'ms', row.metrics ? `ssim2 ${row.metrics.ssimulacra2} butteraugli ${row.metrics.butteraugli}` : '');
      }
      const rapierRow = existsSync(resultsFile) ? readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).find(r => r.codec === 'rapier' && r.image === entry.id && r.tag === tag) : null;
      const encodeLossy = async (effort, distance, warmups, repeats) => helper.encode({width: entry.width, height: entry.height, rgba, effort, distance, warmups, repeats});
      const libjxlLossy = async (ltag, effort, distance) => {
        if (!wanted('libjxl', entry.id, ltag)) return;
        const row = {codec: 'libjxl', ...base, mode: 'lossy', tag: ltag, effort, distance, quality, label: o.label};
        const first = await encodeLossy(effort, distance, 0, 1);
        const repeats = Math.max(1, Math.min(o.maxRepeats, Math.floor(o.budget * 1000 / first.meta.medianMs)));
        const r = repeats > 1 ? await encodeLossy(effort, distance, 1, repeats) : first;
        Object.assign(row, {bytes: r.meta.bytes, bpp: r.meta.bytes * 8 / (entry.width * entry.height), sha256: sha256(r.bytes), ms: r.meta.medianMs, msSamples: r.meta.timesMs, cpuMs: r.meta.medianCpuMs, cpuSamples: r.meta.cpuTimesMs, firstMs: first.meta.medianMs, reps: repeats, loadavg: loadavg()[0]});
        writeFileSync(join(o.out, 'jxl', entry.id + '.libjxl.' + ltag + '.jxl'), r.bytes);
        if (opaque) {
          const d = await decodeWith(decoders[0], r.bytes, scratch);
          if (d.ok) row.metrics = await scoreLossy(image, row, join(scratch, 'djxl.png')); else fail(row, 'djxl refused libjxl output', d.error);
        }
        record(row); console.log('  libjxl', ltag, row.bytes, 'B', row.ms.toFixed(0), 'ms', row.metrics ? `ssim2 ${row.metrics.ssimulacra2} butteraugli ${row.metrics.butteraugli}` : '');
      };
      if (rapierRow?.exact) continue;  // exact result: no lossy comparison
      const d = Number(distanceFromQuality(quality).toFixed(3));
      await libjxlLossy('d-q' + quality + '-e7', 7, d);
      if (quality === o.qualities[0]) await libjxlLossy('d-q' + quality + '-e9', 9, d);
      // A distance whose libjxl effort-7 size matches Rapier's: bisect the distance until the bytes agree within tolerance.
      if (rapierRow && wanted('libjxl', entry.id, 'match-q' + quality + '-e7')) {
        let low = 0.2, high = 25, best = null;
        for (let step = 0; step < 14; step++) {
          const mid = Number(Math.sqrt(low * high).toFixed(3)), r = await encodeLossy(7, mid, 0, 1), error = (r.meta.bytes - rapierRow.bytes) / rapierRow.bytes;
          if (!best || Math.abs(error) < Math.abs(best.error)) best = {distance: mid, error};
          if (Math.abs(error) <= o.matchTolerance) break;
          if (error > 0) low = mid; else high = mid;
        }
        await libjxlLossy('match-q' + quality + '-e7', 7, best.distance);
      }
    }
  }
  await helper.close();
  writeFileSync(join(o.out, 'finished.json'), JSON.stringify({finished: new Date().toISOString(), failures: failures.length}, null, 2) + '\n');
  console.log(failures.length ? failures.length + ' FAILURES (see failures.jsonl)' : 'All decodes passed.');
  if (failures.length) process.exitCode = 2;
}
await main();
