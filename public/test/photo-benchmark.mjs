// SPDX-License-Identifier: MIT
// Photographic rate/distortion and two-decoder conformance. Not an appearance test. Requires ffmpeg with
// libjxl and jxl-oxide-wasm; --download fetches the licensed inputs named and hashed by photo-corpus.json.
// node test/photo-benchmark.mjs --download --dir=/tmp/rapier-photos --output=/tmp/photo-results.json
import {readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join, resolve} from 'node:path';
import {encodePhoto} from '../../photo.mjs';
import {decoder} from './decoder.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(arg => { const [key, ...value] = arg.replace(/^--/, '').split('='); return [key, value.join('=') || true]; }));
const here = fileURLToPath(new URL('.', import.meta.url)), dir = resolve(args.dir || '.photo-corpus');
const ffmpeg = parameters => execFileSync(args.ffmpeg || 'ffmpeg', ['-v', 'error', '-threads', '1', ...parameters], {maxBuffer: 128 * 1024 * 1024});
const hash = data => createHash('sha256').update(data).digest('hex');
const stats = (rgba, rgb, channels = 3) => {
  let se = 0;
  for (let i = 0; i < rgba.length / 4; i++) for (let c = 0; c < 3; c++) se += (rgba[4 * i + c] - rgb[channels * i + c]) ** 2;
  return {psnr: se ? 10 * Math.log10(255 ** 2 / (se / (rgba.length / 4 * 3))) : 999};
};
// An isolated encode measures the encoder's peak resident set, without the decoder's WebAssembly heap.
if (args.encode) {
  const rgba = readFileSync(args.encode), start = performance.now();
  const bytes = encodePhoto(rgba, +args.width, +args.height, {quality: +args.quality});
  const ms = performance.now() - start;
  writeFileSync(args.encoded, bytes);
  // Linux's /proc high-water mark starts at exec; getrusage can include the parent's resident pages at fork.
  const peakRssKiB = process.platform === 'linux' ? +readFileSync('/proc/self/status', 'utf8').match(/^VmHWM:\s+(\d+)/m)[1] : process.resourceUsage().maxRSS;
  console.log(JSON.stringify({bytes: bytes.length, ms, peakRssKiB}));
  process.exit(0);
}

mkdirSync(dir, {recursive: true});
const manifest = JSON.parse(readFileSync(join(here, 'photo-corpus.json'))), decode = await decoder();
if (!decode) throw new Error('jxl-oxide-wasm is required; a missing second decoder is not a pass.');
const rows = [];
for (const photo of manifest.photos) {
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
  ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-i', rawPath, '-frames:v', '1', '-c:v', 'libjxl', '-distance', '1', '-effort', '7', '-y', referencePath]);
  const reference = readFileSync(referencePath), nativeRGB = ffmpeg(['-i', referencePath, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const referencePsnr = stats(rgba, nativeRGB).psnr;
  const q90 = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), `--encode=${rawPath}`, `--encoded=${resultPath}`, `--width=${width}`, `--height=${height}`, '--quality=90'], {encoding: 'utf8'}));
  let decodedOutputs = 0, largestDecoderDifference = 0;
  function readBack(bytes) {
    writeFileSync(resultPath, bytes);
    const native = ffmpeg(['-i', resultPath, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']), oxide = decode(bytes);
    if (native.length !== width * height * 3 || oxide.width !== width || oxide.height !== height || ![1, 3].includes(oxide.channels)) throw new Error(`${photo.id}: decoded dimensions or colour changed`);
    let difference = 0;
    for (let i = 0; i < native.length; i++) difference = Math.max(difference, Math.abs(native[i] - oxide.data[oxide.channels === 1 ? Math.floor(i / 3) : i]));
    // Independent inverse transforms may round a sample one level apart; larger disagreement is data corruption.
    if (difference > 1) throw new Error(`${photo.id}: decoders disagree by ${difference}`);
    largestDecoderDifference = Math.max(largestDecoderDifference, difference); decodedOutputs++;
    return stats(rgba, native).psnr;
  }
  q90.psnr = readBack(readFileSync(resultPath));
  const samples = [{quality: 90, bytes: q90.bytes, psnr: q90.psnr}];
  // Match native d1's RGB PSNR from the better-quality side. Quality is recorded, never relabelled as q90.
  let low = 1, high = 100, matched;
  for (let attempt = 0; attempt < 16; attempt++) {
    const quality = attempt === 0 ? 100 : attempt === 1 ? 1 : (low + high) / 2;
    const bytes = encodePhoto(rgba, width, height, {quality}), psnr = readBack(bytes);
    const sample = {quality, bytes: bytes.length, psnr}; samples.push(sample);
    if (psnr >= referencePsnr) { high = quality; if (!matched || sample.bytes < matched.bytes) matched = sample; } else low = quality;
  }
  if (!matched) throw new Error(`${photo.id}: quality 100 cannot reach native d1 PSNR`);
  const row = {id: photo.id, width, height, sourceSha256: photo.sha256, reference: {bytes: reference.length, psnr: referencePsnr}, q90,
    matched: {...matched, psnrExcess: matched.psnr - referencePsnr, byteRatio: matched.bytes / reference.length}, decodedOutputs, largestDecoderDifference, samples};
  rows.push(row);
  console.log(JSON.stringify({...row, samples: undefined}));
}
const referenceBytes = rows.reduce((n, r) => n + r.reference.bytes, 0), photoBytes = rows.reduce((n, r) => n + r.matched.bytes, 0);
let nativePackage = null;
try { nativePackage = execFileSync('dpkg-query', ['-W', '-f=${Version}', 'libjxl0.7'], {encoding: 'utf8'}); } catch {}
const result = {node: process.version, nativePackage, reference: 'native libjxl, distance 1, effort 7; sRGB RGB PSNR; alpha omitted from error',
  matching: 'Sixteen quality probes per image; retain smallest output whose RGB PSNR is at least the native distance-1 output; quality is recorded separately from fixed q90.',
  summary: {photos: rows.length, decodedOutputs: rows.reduce((n, r) => n + r.decodedOutputs, 0), referenceBytes, matchedBytes: photoBytes,
    totalByteRatio: photoBytes / referenceBytes, worstByteRatio: Math.max(...rows.map(r => r.matched.byteRatio)),
    within1_3: rows.filter(r => r.matched.byteRatio <= 1.3).length, maxPsnrExcess: Math.max(...rows.map(r => r.matched.psnrExcess)),
    q90EncodeMs: rows.reduce((n, r) => n + r.q90.ms, 0), q90PeakRssKiB: Math.max(...rows.map(r => r.q90.peakRssKiB))}, rows};
if (args.output) writeFileSync(args.output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result.summary));
