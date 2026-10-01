// SPDX-License-Identifier: MIT
// Photographic rate/distortion and two-decoder conformance. Not an appearance test. Requires ffmpeg with
// libjxl and jxl-oxide-wasm; --download fetches the licensed inputs named and hashed by photo-corpus.json.
// node test/photo-benchmark.mjs --download --dir=/tmp/rapier-photos --effort=5 --output=/tmp/photo-results.json
import {readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {join, resolve, dirname, relative} from 'node:path';
import {decoder} from './decoder.mjs';
import {nativeDecoder} from './native-decoder.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(arg => { const [key, ...value] = arg.replace(/^--/, '').split('='); return [key, value.join('=') || true]; }));
const here = fileURLToPath(new URL('.', import.meta.url)), dir = resolve(args.dir || '.photo-corpus');
const effort = Number(args.effort || 1);
if (!Number.isSafeInteger(effort) || effort < 1 || effort > 9) throw new Error('Effort must be a whole number from 1 to 9.');
const source = resolve(args.source || fileURLToPath(new URL('../../', import.meta.url)));
const hash = data => createHash('sha256').update(data).digest('hex');
function sourceHashes() {
  const hashes = {}, visit = path => {
    const name = relative(source, path);
    if (Object.hasOwn(hashes, name)) return;
    const bytes = readFileSync(path), code = bytes.toString('utf8');
    hashes[name] = hash(bytes);
    for (const match of code.matchAll(/(?:\bfrom\s*|\bimport\s*)(['"])(\.[^'"]+)\1/g)) visit(resolve(dirname(path), match[2]));
  };
  visit(join(source, 'photo.mjs'));
  return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
const sources = sourceHashes(), programHash = hash(readFileSync(fileURLToPath(import.meta.url)));
const {encodePhoto} = await import(pathToFileURL(join(source, 'photo.mjs')));
const ffmpeg = parameters => execFileSync(args.ffmpeg || 'ffmpeg', ['-v', 'error', '-threads', '1', ...parameters], {maxBuffer: 128 * 1024 * 1024});
const stats = (rgba, rgb, channels = 3) => {
  let se = 0;
  for (let i = 0; i < rgba.length / 4; i++) for (let c = 0; c < 3; c++) se += (rgba[4 * i + c] - rgb[channels * i + c]) ** 2;
  return {rgbSse: se, psnr: se ? 10 * Math.log10(255 ** 2 / (se / (rgba.length / 4 * 3))) : 999};
};
// An isolated encode measures the encoder's peak resident set, without the decoder's WebAssembly heap.
if (args.encode) {
  const rgba = readFileSync(args.encode), start = performance.now();
  const bytes = encodePhoto(rgba, +args.width, +args.height, {quality: +args.quality, effort});
  const ms = performance.now() - start;
  writeFileSync(args.encoded, bytes);
  // Linux's /proc high-water mark starts at exec; getrusage can include the parent's resident pages at fork.
  const peakRssKiB = process.platform === 'linux' ? +readFileSync('/proc/self/status', 'utf8').match(/^VmHWM:\s+(\d+)/m)[1] : process.resourceUsage().maxRSS;
  console.log(JSON.stringify({bytes: bytes.length, sha256: hash(bytes), ms, peakRssKiB}));
  process.exit(0);
}

mkdirSync(dir, {recursive: true});
const manifest = JSON.parse(readFileSync(join(here, 'photo-corpus.json'))), decode = await decoder();
if (!decode) throw new Error('jxl-oxide-wasm is required; a missing second decoder is not a pass.');
const native = args.native ? await nativeDecoder({executable: args.native}) : null;
const photos = args.ids ? manifest.photos.filter(photo => args.ids.split(',').includes(photo.id)) : manifest.photos;
if (args.ids && photos.length !== new Set(args.ids.split(',')).size) throw new Error('Every --ids entry must name a manifest photograph.');
const rows = [];
try { for (const photo of photos) {
  const path = join(dir, photo.id + '.jpg');
  if (!existsSync(path) && photo.file) copyFileSync(join(here, photo.file), path);
  if (!existsSync(path) && args.download) {
    const response = await fetch(photo.download);
    if (!response.ok) throw new Error(`Download failed: ${photo.id} (${response.status})`);
    writeFileSync(path, new Uint8Array(await response.arrayBuffer()));
  }
  if (!existsSync(path)) throw new Error(`${path} is missing; pass --download to fetch the manifest's licensed input.`);
  if (hash(readFileSync(path)) !== photo.sha256) throw new Error(`Source changed: ${photo.id}; never silently benchmark a different photograph.`);
  const {width, height} = photo, rgba = ffmpeg(['-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  if (rgba.length !== width * height * 4) throw new Error(`Unexpected dimensions: ${photo.id}`);
  const rawPath = join(dir, photo.id + '.rgba'), referencePath = join(dir, photo.id + '-reference.jxl'), resultPath = join(dir, photo.id + '-photo.jxl');
  writeFileSync(rawPath, rgba);
  if (args.cjxl) {
    const rgb = Buffer.alloc(width * height * 3), ppm = join(dir, photo.id + '-reference.ppm');
    for (let i = 0; i < width * height; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = rgba[i * 4 + c];
    writeFileSync(ppm, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), rgb]));
    execFileSync(args.cjxl, [ppm, referencePath, '-d', '1', '-e', '7', '--num_threads=1', '--quiet'], {stdio: ['ignore', 'pipe', 'pipe']});
  } else ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-i', rawPath, '-frames:v', '1', '-c:v', 'libjxl', '-distance', '1', '-effort', '7', '-y', referencePath]);
  const reference = readFileSync(referencePath), nativeRGB = native ? await native.decode(reference, width, height) : ffmpeg(['-i', referencePath, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const referenceStats = stats(rgba, nativeRGB, native ? 4 : 3), referencePsnr = referenceStats.psnr;
  const q90 = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), `--encode=${rawPath}`, `--encoded=${resultPath}`, `--width=${width}`, `--height=${height}`, '--quality=90', `--effort=${effort}`, `--source=${source}`], {encoding: 'utf8'}));
  let decodedOutputs = 0, largestDecoderDifference = 0;
  async function readBack(bytes) {
    writeFileSync(resultPath, bytes);
    const channels = native ? 4 : 3, back = native ? await native.decode(bytes, width, height) : ffmpeg(['-i', resultPath, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']), oxide = decode(bytes);
    if (back.length !== width * height * channels || oxide.width !== width || oxide.height !== height || ![1, 3].includes(oxide.channels)) throw new Error(`${photo.id}: decoded dimensions or colour changed`);
    let difference = 0;
    for (let i = 0; i < width * height; i++) for (let c = 0; c < 3; c++) difference = Math.max(difference, Math.abs(back[i * channels + c] - oxide.data[i * oxide.channels + (oxide.channels === 1 ? 0 : c)]));
    // Independent inverse transforms may round a sample one level apart; larger disagreement is data corruption.
    if (difference > 1) throw new Error(`${photo.id}: decoders disagree by ${difference}`);
    largestDecoderDifference = Math.max(largestDecoderDifference, difference); decodedOutputs++;
    return stats(rgba, back, channels);
  }
  Object.assign(q90, await readBack(readFileSync(resultPath)));
  const samples = [{quality: 90, bytes: q90.bytes, sha256: q90.sha256, rgbSse: q90.rgbSse, psnr: q90.psnr}];
  // Match native d1's RGB PSNR from the better-quality side. Quality is recorded, never relabelled as q90.
  let low = 1, high = 100, matched;
  for (let attempt = 0; attempt < 16; attempt++) {
    const quality = attempt === 0 ? 100 : attempt === 1 ? 1 : (low + high) / 2;
    const bytes = encodePhoto(rgba, width, height, {quality, effort}), reconstruction = await readBack(bytes);
    const sample = {quality, bytes: bytes.length, sha256: hash(bytes), ...reconstruction}, {psnr} = reconstruction; samples.push(sample);
    if (psnr >= referencePsnr) { high = quality; if (!matched || sample.bytes < matched.bytes) matched = sample; } else low = quality;
  }
  if (!matched) throw new Error(`${photo.id}: quality 100 cannot reach native d1 PSNR`);
  const row = {id: photo.id, width, height, sourceSha256: photo.sha256, rgbaSha256: hash(rgba), reference: {bytes: reference.length, sha256: hash(reference), ...referenceStats}, q90,
    matched: {...matched, psnrExcess: matched.psnr - referencePsnr, byteRatio: matched.bytes / reference.length}, decodedOutputs, largestDecoderDifference, samples};
  rows.push(row);
  console.log(JSON.stringify({...row, samples: undefined}));
} } finally { if (native) await native.close(); }
if (JSON.stringify(sourceHashes()) !== JSON.stringify(sources) || hash(readFileSync(fileURLToPath(import.meta.url))) !== programHash) throw new Error('Encoder module graph or measurement program changed during the run.');
const referenceBytes = rows.reduce((n, r) => n + r.reference.bytes, 0), photoBytes = rows.reduce((n, r) => n + r.matched.bytes, 0);
let nativePackage = null;
try { nativePackage = execFileSync('dpkg-query', ['-W', '-f=${Version}', 'libjxl0.7'], {encoding: 'utf8'}); } catch {}
const result = {node: process.version, effort, source, sources, programHash, nativePackage, nativeDecoder: native?.version || null,
  referenceEncoder: args.cjxl ? execFileSync(args.cjxl, ['--version'], {encoding: 'utf8'}).trim() : 'ffmpeg libjxl',
  reference: 'native libjxl, distance 1, effort 7, one thread with cjxl; sRGB RGB PSNR; alpha omitted from error',
  matching: 'Sixteen quality probes per image; retain smallest output whose RGB PSNR is at least the native distance-1 output; quality is recorded separately from fixed q90.',
  summary: {photos: rows.length, decodedOutputs: rows.reduce((n, r) => n + r.decodedOutputs, 0), referenceBytes, matchedBytes: photoBytes,
    totalByteRatio: photoBytes / referenceBytes, worstByteRatio: Math.max(...rows.map(r => r.matched.byteRatio)),
    within1_3: rows.filter(r => r.matched.byteRatio <= 1.3).length, maxPsnrExcess: Math.max(...rows.map(r => r.matched.psnrExcess)),
    q90EncodeMs: rows.reduce((n, r) => n + r.q90.ms, 0), q90PeakRssKiB: Math.max(...rows.map(r => r.q90.peakRssKiB))}, rows};
if (args.output) writeFileSync(args.output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result.summary));
