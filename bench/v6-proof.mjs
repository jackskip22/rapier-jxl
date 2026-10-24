// SPDX-License-Identifier: MIT
// The v6 proof run, one command: every picture of each corpus through rapier-jxl at its efforts, libjxl's cjxl at e7 and
// e9, mozjpeg, WebP and AVIF, each file scored by libjxl 0.12.0's ssimulacra2 and butteraugli_main on its decoded pixels.
// Every JPEG XL file is decoded by djxl and jxl-oxide (pixels compared) and then by Chrome 155 (pixels compared with djxl).
// JPEG corpora also run exact transcoding (rapier-jxl/jpeg against cjxl), each file restored by djxl byte for byte.
//
// node v6-proof.mjs <out.json> --corpus kodak=<dir of PNG> [--corpus phone=<dir of PNG>] [--jpeg phone=<dir of JPEG>]
//   [--encoders v6:1,v6:7,v6:9,cjxl:7,cjxl:9,mozjpeg,webp,avif] [--files <dir>] [--chrome <path>] [--workers n]
//   [--score ssimulacra2=70,80,90] [--score butteraugli3=1.5,1.0] [--only <image name>,...] [--resume <earlier out.json>] [--grid <encoder>=<settings>] [--order image]
// Tools: JXL_TOOLS (cjxl, djxl, ssimulacra2, butteraugli_main of libjxl 0.12.0), JXL_OXIDE (jxl-oxide 0.12.6 CLI, or `wasm`
// for the WebAssembly build Rapier vendors), MOZJPEG
// (directory holding mozjpeg 4.1.5 cjpeg and djpeg), CWEBP, DWEBP, AVIFENC, AVIFDEC; Chrome through PLAYWRIGHT_ROOT.
// `v6-wins.mjs` turns the result into the README's numbers.
import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';
import {execFileSync, spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync, rmSync} from 'node:fs';
import {availableParallelism, cpus, tmpdir} from 'node:os';
import {join, basename, extname, dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const tools = process.env.JXL_TOOLS || '/home/user/tools/tools';
const tool = (name, env, fallback) => process.env[env] || fallback || name;
const T = {
  cjxl: join(tools, 'cjxl'), djxl: join(tools, 'djxl'), ssimulacra2: join(tools, 'ssimulacra2'), butteraugli: join(tools, 'butteraugli_main'),
  oxide: tool('jxl-oxide', 'JXL_OXIDE'), cjpeg: join(process.env.MOZJPEG || '', 'cjpeg'), djpeg: join(process.env.MOZJPEG || '', 'djpeg'),
  cwebp: tool('cwebp', 'CWEBP'), dwebp: tool('dwebp', 'DWEBP'), avifenc: tool('avifenc', 'AVIFENC'), avifdec: tool('avifdec', 'AVIFDEC'),
};
// Settings per encoder: wide enough that every picture crosses SSIMULACRA2 60 to 90 and Butteraugli 3-norm 2.0 to 0.7.
export const GRIDS = {
  v6: [30, 45, 58, 68, 76, 82, 87, 90, 93, 95, 97, 98],
  cjxl: [30, 45, 58, 68, 76, 82, 87, 90, 93, 95, 97],
  mozjpeg: [40, 55, 68, 78, 85, 90, 93, 95, 97, 98, 99],
  webp: [40, 55, 68, 78, 85, 90, 93, 95, 97, 99, 100],
  avif: [30, 45, 55, 64, 72, 79, 85, 89, 93, 96, 98],
};
const run = (cmd, args) => execFileSync(cmd, args, {stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26});
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

if (!isMainThread) await worker();
else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

async function main() {
  const args = process.argv.slice(2), take = name => { const v = []; for (let i; (i = args.indexOf(name)) >= 0;) v.push(args.splice(i, 2)[1]); return v; };
  const corpora = take('--corpus').map(s => s.split('=')), jpegs = take('--jpeg').map(s => s.split('='));
  const encoders = (take('--encoders')[0] || 'v6:1,v6:7,v6:9,cjxl:7,cjxl:9,mozjpeg,webp,avif').split(',');
  const files = resolve(take('--files')[0] || join(tmpdir(), 'v6-proof-files')), chrome = take('--chrome')[0] || process.env.RAPIER_CHROME;
  const workers = Number(take('--workers')[0] || availableParallelism()), only = take('--only')[0]?.split(','), resume = take('--resume')[0];
  for (const g of take('--grid')) { const [enc, list] = g.split('='); GRIDS[enc] = list.split(',').map(Number); }
  const byImage = take('--order')[0] === 'image';
  // --score ssimulacra2=70,80,90 --score butteraugli3=1.5,1.0: encodeToScore (rapier-jxl/score, CPU, effort 7) per picture.
  const scores = take('--score').flatMap(s => { const [key, list] = s.split('='); return list.split(',').map(v => ({[key]: Number(v)})); });
  const out = args[0];
  if (!out || (!corpora.length && !jpegs.length)) throw new Error('usage: v6-proof.mjs <out.json> --corpus name=<dir> [--jpeg name=<dir>]');
  const report = resume ? JSON.parse(readFileSync(resume)) : {version: 1, tools: versions(), cpu: cpus()[0]?.model, corpora: {}, jpeg: {}, chrome: null};
  report.started = new Date().toISOString();
  report.grids = GRIDS; report.workers = workers;
  const pool = Array.from({length: workers}, () => new Worker(fileURLToPath(import.meta.url), {workerData: {files}}));
  const idle = [...pool], queue = [];
  const pump = () => { while (idle.length && queue.length) { const w = idle.pop(), {job, resolve, reject} = queue.shift(); w.once('message', m => { idle.push(w); if (m.error) console.error(job.image + ' ' + job.encoder + ' ' + (job.setting ?? '') + ': ' + m.error.split('\n')[0]); resolve(m); pump(); }); w.postMessage(job); } };
  const submit = job => new Promise((resolve, reject) => { queue.push({job, resolve, reject}); pump(); });
  const save = () => writeFileSync(out, JSON.stringify(report, null, 1));
  const tasks = [];
  for (const [name, dir] of corpora) {
    const corpus = report.corpora[name] ||= {dir: basename(dir), images: {}};
    for (const file of listImages(dir, ['.png'], only)) {
      const image = corpus.images[basename(file)] ||= {};
      for (const target of scores) {
        const key = 'score:' + Object.entries(target)[0].join('=');
        if (!image[key]) tasks.push({cost: 120, job: {kind: 'score', corpus: name, file, image: basename(file), encoder: key, target}});
      }
      for (const encoder of encoders) {
        const done = new Set((image[encoder] || []).map(p => p.setting));
        for (const setting of GRIDS[encoder.split(':')[0]]) if (!done.has(setting))
          tasks.push({cost: cost(encoder, setting), job: {kind: 'lossy', corpus: name, file, image: basename(file), encoder, setting}});
      }
    }
  }
  for (const [name, dir] of jpegs) {
    const corpus = report.jpeg[name] ||= {dir: basename(dir), images: {}};
    for (const file of listImages(dir, ['.jpg', '.jpeg'], only)) {
      const image = corpus.images[basename(file)] ||= {bytes: statSync(file).size};
      for (const encoder of ['v6:1', 'v6:7', 'v6:9', 'cjxl:7', 'cjxl:9']) if (!image[encoder])
        tasks.push({cost: 1, job: {kind: 'jpeg', corpus: name, file, image: basename(file), encoder}});
    }
  }
  // Longest first, so the slow effort-9 points start while the quick ones fill the gaps; or (--order image) whole pictures
  // first, so a run cut short by a time limit still returns complete pictures.
  tasks.forEach((t, i) => { t.i = i; });
  tasks.sort(byImage ? (a, b) => a.job.image.localeCompare(b.job.image) || a.job.kind.localeCompare(b.job.kind) || b.cost - a.cost || a.i - b.i : (a, b) => b.cost - a.cost || a.i - b.i);
  let finished = 0, last = Date.now();
  console.error(tasks.length + ' encodes on ' + workers + ' workers');
  await Promise.all(tasks.map(({job}) => submit(job).then(point => {
    if (job.kind === 'jpeg') report.jpeg[job.corpus].images[job.image][job.encoder] = point;
    else if (job.kind === 'score') report.corpora[job.corpus].images[job.image][job.encoder] = [point];
    else ((report.corpora[job.corpus].images[job.image])[job.encoder] ||= []).push(point);
    finished++;
    if (Date.now() - last > 30000) { last = Date.now(); save(); console.error(finished + '/' + tasks.length); }
  })));
  for (const w of pool) w.terminate();
  for (const corpus of Object.values(report.corpora)) for (const image of Object.values(corpus.images)) for (const points of Object.values(image)) points.sort((a, b) => a.setting - b.setting);
  if (chrome) report.chrome = await chromeCheck(chrome, files, report);
  report.finished = new Date().toISOString();
  save();
  const problems = audit(report), notes = libjxlNotes(report);
  if (notes.length) console.error('libjxl files the decoders disagree on (not ours):\n' + notes.join('\n'));
  console.error(problems.length ? problems.join('\n') : 'every rapier-jxl file decoded as promised');
  if (problems.length) process.exitCode = 1;
}

// Seconds per encode, roughly, for scheduling only.
function cost(encoder, setting) { return encoder === 'v6:9' ? 40 : encoder === 'v6:8' ? 20 : encoder === 'avif' ? 2 : 1; }

function listImages(dir, exts, only) {
  return readdirSync(dir).filter(f => exts.includes(extname(f).toLowerCase()) && (!only || only.includes(f))).sort().map(f => join(dir, f));
}

function versions() {
  // Some tools print their version on stderr (mozjpeg's cjpeg), some exit non-zero after printing it.
  const v = (cmd, args) => { try { return execFileSync(cmd, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).split('\n')[0].trim(); } catch (e) { return String(e.stderr || e.message).split('\n')[0].trim(); } };
  const both = (cmd, args) => { const r = spawnSync(cmd, args, {encoding: 'utf8'}); return ((r.stdout || '') + (r.stderr || '')).split('\n')[0].trim(); };
  return {node: process.version, cjxl: v(T.cjxl, ['--version']), oxide: T.oxide === 'wasm' ? 'jxl-oxide-wasm 0.12.6 (vendored)' : v(T.oxide, ['--version']), cwebp: 'cwebp ' + v(T.cwebp, ['-version']),
    avifenc: v(T.avifenc, ['--version']), mozjpeg: both(T.cjpeg, ['-version'])};
}

// Every rapier-jxl file: djxl and jxl-oxide agree; Chrome agrees with djxl. Every exact JPEG restores byte for byte.
// libjxl's own files are decoded the same way, and their disagreements are listed by libjxlNotes, not refused.
function ours(encoder) { return /^(v6|score):/.test(encoder); }
export function libjxlNotes(report) {
  const notes = [];
  for (const [name, corpus] of Object.entries(report.corpora)) for (const [image, encoders] of Object.entries(corpus.images))
    for (const [encoder, points] of Object.entries(encoders)) if (!ours(encoder) && /^cjxl:/.test(encoder)) for (const p of points)
      if (p.oxideMaxDiff > 1 || p.chromeMaxDiff === null || p.chromeMaxDiff > 1) notes.push(`${name}/${image} ${encoder} q${p.setting}: jxl-oxide ${p.oxideMaxDiff}/255, Chrome ${p.chromeMaxDiff}/255 from djxl`);
  return notes;
}
export function audit(report) {
  const problems = [];
  for (const [name, corpus] of Object.entries(report.corpora)) for (const [image, encoders] of Object.entries(corpus.images))
    for (const [encoder, points] of Object.entries(encoders)) if (ours(encoder)) for (const p of points) {
      if (p.error) { problems.push(`${name}/${image} ${encoder} q${p.setting}: ${p.error.split('\n')[0]}`); continue; }
      if (p.oxideMaxDiff !== undefined && p.oxideMaxDiff > 1) problems.push(`${name}/${image} ${encoder} q${p.setting}: jxl-oxide differs from djxl by ${p.oxideMaxDiff}/255`);
      if (p.chromeMaxDiff !== undefined && (p.chromeMaxDiff === null || p.chromeMaxDiff > 1)) problems.push(`${name}/${image} ${encoder} q${p.setting}: Chrome ${p.chromeMaxDiff === null ? 'did not decode' : 'differs from djxl by ' + p.chromeMaxDiff + '/255'}`);
    }
  for (const [name, corpus] of Object.entries(report.jpeg)) for (const [image, encoders] of Object.entries(corpus.images))
    for (const [encoder, p] of Object.entries(encoders)) if (typeof p === 'object') {
      if (p.error) { problems.push(`${name}/${image} ${encoder}: ${p.error.split('\n')[0]}`); continue; }
      if (!ours(encoder)) { if (!p.djxlExact) problems.push(`${name}/${image} ${encoder}: libjxl's file does not restore the JPEG exactly`); continue; }
      if (!p.djxlExact) problems.push(`${name}/${image} ${encoder}: djxl does not restore the JPEG exactly`);
      if (p.rapierExact === false) problems.push(`${name}/${image} ${encoder}: reconstructJPEG does not restore the JPEG exactly`);
      if (p.chromeMaxDiff !== undefined && (p.chromeMaxDiff === null || p.chromeMaxDiff > 1)) problems.push(`${name}/${image} ${encoder}: Chrome ${p.chromeMaxDiff === null ? 'did not decode' : 'differs from djxl by ' + p.chromeMaxDiff + '/255'}`);
    }
  return problems;
}

async function worker() {
  const {readPng, writePng} = await import(pathToFileURL(join(here, 'image-io.mjs')));
  const {encode} = await import(pathToFileURL(join(here, '../src/effort.mjs')));
  // rapier-jxl/jpeg-ans: exact transcoding with the ANS candidates (the smallest exact files).
  const jpegModule = await import(pathToFileURL(join(here, '../src/jpeg-ans.mjs')));
  const scoreModule = await import(pathToFileURL(join(here, '../src/score.mjs')));
  // jxl-oxide 0.12.6: the CLI named by JXL_OXIDE, or with JXL_OXIDE=wasm the WebAssembly build Rapier vendors.
  const oxideWasm = T.oxide === 'wasm' ? await (await import(pathToFileURL(join(here, '../test/decoder.mjs')))).decoder() : null;
  if (T.oxide === 'wasm' && !oxideWasm) throw new Error('JXL_OXIDE=wasm, but no jxl-oxide-wasm or vendored copy was found');
  const oxidePixels = (file, scratchPng) => {
    if (!oxideWasm) { run(T.oxide, [file, '-o', scratchPng, '-f', 'png8']); return readPng(readFileSync(scratchPng)); }
    const {width, height, channels, data} = oxideWasm(readFileSync(file)), rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) for (let c = 0; c < 4; c++) rgba[i * 4 + c] = c === 3 ? (channels === 4 || channels === 2 ? data[i * channels + channels - 1] : 255) : data[i * channels + (channels >= 3 ? c : 0)];
    return {width, height, rgba};
  };
  const files = workerData.files, scratch = join(tmpdir(), 'v6-proof-' + process.pid + '-' + Math.random().toString(36).slice(2));
  mkdirSync(scratch, {recursive: true});
  let cached = null;
  const pixels = file => cached?.file === file ? cached.image : (cached = {file, image: readPng(readFileSync(file))}).image;
  const maxDiff = (a, b) => {
    if (a.width !== b.width || a.height !== b.height) return 255;
    let m = 0; const x = a.rgba, y = b.rgba;
    for (let i = 0; i < x.length; i++) { if ((i & 3) === 3) continue; const d = Math.abs(x[i] - y[i]); if (d > m) m = d; }
    return m;
  };
  const score = (png, decoded) => {
    const s = Number(run(T.ssimulacra2, [png, decoded]).toString().trim());
    const b = run(T.butteraugli, [png, decoded, '--pnorm', '3']).toString();
    return {ssimulacra2: +s.toFixed(4), butteraugli: +Number(b.split('\n')[0]).toFixed(4), ba3: +Number(/3-norm: ([\d.]+)/.exec(b)[1]).toFixed(4)};
  };
  parentPort.on('message', job => {
    try { parentPort.postMessage(job.kind === 'jpeg' ? jpegJob(job) : job.kind === 'score' ? scoreJob(job) : lossyJob(job)); }
    catch (e) { parentPort.postMessage({setting: job.setting ?? job.encoder, error: String(e.stack || e).slice(0, 600)}); }
  });

  function lossyJob({corpus, file, image, encoder, setting}) {
    const [kind, effort] = encoder.split(':'), stem = image.replace(/\.png$/i, '');
    const dir = join(files, corpus, encoder.replace(':', '')); mkdirSync(dir, {recursive: true});
    const ext = {v6: 'jxl', cjxl: 'jxl', mozjpeg: 'jpg', webp: 'webp', avif: 'avif'}[kind];
    const target = join(dir, `${stem}.q${setting}.${ext}`), decoded = join(scratch, 'decoded.png');
    let ms;
    const t = process.hrtime.bigint();
    if (kind === 'v6') {
      const {rgba, width, height} = pixels(file);
      const started = process.hrtime.bigint();
      const bytes = encode(rgba, width, height, {quality: setting, effort: Number(effort)});
      ms = Number(process.hrtime.bigint() - started) / 1e6;
      writeFileSync(target, bytes);
    } else {
      if (kind === 'cjxl') run(T.cjxl, [file, target, '-q', String(setting), '-e', effort, '--num_threads=0']);
      else if (kind === 'mozjpeg') { writeFileSync(target, run(T.cjpeg, ['-quality', String(setting), file])); }
      else if (kind === 'webp') run(T.cwebp, ['-quiet', '-m', '6', '-q', String(setting), '-sharp_yuv', file, '-o', target]);
      else if (kind === 'avif') run(T.avifenc, ['-q', String(setting), '-s', '6', '-j', '1', file, target]);
      ms = Number(process.hrtime.bigint() - t) / 1e6;
    }
    const point = {setting, bytes: statSync(target).size, ms: Math.round(ms)};
    if (ext === 'jxl') {
      run(T.djxl, [target, decoded, '--bits_per_sample=8', '--num_threads=0']);
      point.oxideMaxDiff = maxDiff(readPng(readFileSync(decoded)), oxidePixels(target, join(scratch, 'oxide.png')));
      point.sha256 = sha256(readFileSync(target)).slice(0, 16);
    } else if (kind === 'mozjpeg') writeFileSync(decoded, pnm2png(run(T.djpeg, [target]), writePng));
    else if (kind === 'webp') run(T.dwebp, ['-quiet', target, '-o', decoded]);
    else run(T.avifdec, ['-j', '1', target, decoded]);
    // libjxl's tools score the PNG every decoder agreed on (djxl's 8-bit output for JPEG XL, like a browser shows it).
    Object.assign(point, score(file, decoded));
    return point;
  }

  // encodeToScore on the CPU; the file is then scored and decoded like every other.
  function scoreJob({corpus, file, image, encoder, target}) {
    const stem = image.replace(/\.png$/i, ''), dir = join(files, corpus, encoder.replace(/[:=]/g, '-')); mkdirSync(dir, {recursive: true});
    const out = join(dir, stem + '.jxl'), decoded = join(scratch, 'decoded.png'), oxide = join(scratch, 'oxide.png');
    const {rgba, width, height} = pixels(file), started = process.hrtime.bigint();
    const steps = scoreModule.encodeToScoreSteps(rgba, width, height, {target});
    let step; while (!(step = steps.next()).done);
    const ms = Number(process.hrtime.bigint() - started) / 1e6, r = step.value;
    writeFileSync(out, r.bytes);
    run(T.djxl, [out, decoded, '--bits_per_sample=8', '--num_threads=0']);
    return {setting: encoder, bytes: r.bytes.length, ms: Math.round(ms), quality: r.quality, candidate: r.candidate,
      own: {butteraugli: r.butteraugli, butteraugli3: r.butteraugli3, ssimulacra2: r.ssimulacra2},
      oxideMaxDiff: maxDiff(readPng(readFileSync(decoded)), oxidePixels(out, oxide)), sha256: sha256(r.bytes).slice(0, 16), ...score(file, decoded)};
  }

  function jpegJob({corpus, file, image, encoder}) {
    const [kind, effort] = encoder.split(':'), stem = image.replace(/\.jpe?g$/i, ''), original = readFileSync(file);
    const dir = join(files, corpus + '-jpeg', encoder.replace(':', '')); mkdirSync(dir, {recursive: true});
    const target = join(dir, stem + '.jxl'), restored = join(scratch, 'restored.jpg');
    const t = process.hrtime.bigint();
    let rapierExact;
    if (kind === 'v6') {
      const {bytes} = jpegModule.transcode(original, {effort: Number(effort)});
      writeFileSync(target, bytes);
      rapierExact = Buffer.from(jpegModule.reconstructJPEG(bytes) || []).equals(original);
    } else run(T.cjxl, [file, target, '--lossless_jpeg=1', '-e', effort, '--num_threads=0']);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    run(T.djxl, [target, restored, '--num_threads=0']);
    const point = {bytes: statSync(target).size, ms: Math.round(ms), djxlExact: readFileSync(restored).equals(original), sha256: sha256(readFileSync(target)).slice(0, 16)};
    if (rapierExact !== undefined) point.rapierExact = rapierExact;
    return point;
  }
}

function pnm2png(pnm, writePng) {
  // djpeg writes binary PPM (P6) or PGM (P5).
  let at = 0; const field = () => { while (/\s/.test(String.fromCharCode(pnm[at]))) at++; let s = ''; while (!/\s/.test(String.fromCharCode(pnm[at]))) s += String.fromCharCode(pnm[at++]); return s; };
  const magic = field(), width = Number(field()), height = Number(field()); field(); at++;
  const channels = magic === 'P6' ? 3 : 1, rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) for (let c = 0; c < 4; c++) rgba[i * 4 + c] = c === 3 ? 255 : pnm[at + i * channels + (channels === 3 ? c : 0)];
  return writePng(width, height, rgba);
}

// Chrome 155 decodes every JPEG XL file of the run (createImageBitmap, then the canvas's pixels) and is compared with djxl.
async function chromeCheck(chromePath, files, report) {
  const root = process.env.PLAYWRIGHT_ROOT || '/opt/node-tools/node_modules';
  const {chromium} = await import(pathToFileURL(join(root, 'playwright-core/index.mjs')));
  const {readPng} = await import(pathToFileURL(join(here, 'image-io.mjs')));
  const browser = await chromium.launch({executablePath: chromePath, args: ['--no-sandbox']});
  const page = await browser.newPage(), version = browser.version();
  await page.goto('about:blank');
  const decodeIn = async bytes => page.evaluate(async b64 => {
    try {
      const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bin], {type: 'image/jxl'}), {colorSpaceConversion: 'none', premultiplyAlpha: 'none'});
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d', {colorSpace: 'srgb'});
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let s = ''; for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
      return {width: bitmap.width, height: bitmap.height, rgba: btoa(s)};
    } catch (e) { return {error: String(e)}; }
  }, bytes.toString('base64'));
  const scratch = join(tmpdir(), 'v6-proof-chrome-' + process.pid); mkdirSync(scratch, {recursive: true});
  const compare = async (file) => {
    const got = await decodeIn(readFileSync(file));
    if (got.error) return null;
    run(T.djxl, [file, join(scratch, 'd.png'), '--bits_per_sample=8', '--num_threads=0']);
    const ref = readPng(readFileSync(join(scratch, 'd.png'))), rgba = Buffer.from(got.rgba, 'base64');
    if (ref.width !== got.width || ref.height !== got.height) return 255;
    let m = 0; for (let i = 0; i < rgba.length; i++) { if ((i & 3) === 3) continue; const d = Math.abs(rgba[i] - ref.rgba[i]); if (d > m) m = d; }
    return m;
  };
  let n = 0;
  for (const [name, corpus] of Object.entries(report.corpora)) for (const [image, encoders] of Object.entries(corpus.images))
    for (const [encoder, points] of Object.entries(encoders)) if (/^(v6|cjxl|score):/.test(encoder)) for (const p of points) {
      if (p.chromeMaxDiff !== undefined) continue;
      const stem = image.replace(/\.png$/i, '');
      p.chromeMaxDiff = await compare(encoder.startsWith('score:') ? join(files, name, encoder.replace(/[:=]/g, '-'), stem + '.jxl') : join(files, name, encoder.replace(':', ''), `${stem}.q${p.setting}.jxl`)); n++;
    }
  for (const [name, corpus] of Object.entries(report.jpeg)) for (const [image, encoders] of Object.entries(corpus.images))
    for (const [encoder, p] of Object.entries(encoders)) if (typeof p === 'object' && p.chromeMaxDiff === undefined) {
      p.chromeMaxDiff = await compare(join(files, name + '-jpeg', encoder.replace(':', ''), image.replace(/\.jpe?g$/i, '') + '.jxl')); n++;
    }
  await browser.close();
  rmSync(scratch, {recursive: true, force: true});
  return {version, files: n};
}
