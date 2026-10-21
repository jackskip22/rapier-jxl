// SPDX-License-Identifier: MIT
// Animated JPEG XL against the formats people use for the same frames: the original GIF (or a 256-color GIF made by
// ffmpeg), APNG and animated WebP written by Pillow (both store changed rectangles), and libjxl's cjxl. Bytes, time
// per frame on one thread, and for lossy files the mean SSIMULACRA2 of every fifth frame decoded by djxl or Pillow.
// Usage: node animation.mjs <prepared corpus> <out.json> [--cjxl <cjxl>] [--djxl <djxl>] [--ssimulacra2 <tool>] [--only <name>]
// [--rapier-only] (Rapier rows alone, to merge into an earlier run's comparisons)
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {encodeAnimation} from '../src/animation.mjs';
import {readAPNG} from '../test/animation-oracles.mjs';

const run = promisify(execFile), argv = process.argv.slice(2), flag = name => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
const [corpus, output] = argv, rapierOnly = argv.includes('--rapier-only'), cjxl = flag('--cjxl'), djxl = flag('--djxl'), ssimulacra2 = flag('--ssimulacra2'), only = flag('--only');
if (!corpus || !output) { console.error('usage: node animation.mjs <prepared corpus> <out.json> [--cjxl <cjxl>] [--djxl <djxl>] [--ssimulacra2 <tool>]'); process.exit(2); }
const work = await mkdtemp(join(tmpdir(), 'jxl-animation-bench-'));
const SOURCES = JSON.parse(await readFile(new URL('animation-sources.json', import.meta.url), 'utf8')).sources;

// Pillow writes APNG, GIF and WebP from raw frames, and decodes WebP back to raw frames.
const PILLOW = `
import sys, json
from PIL import Image
op, raw, w, h, durations, target = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), json.loads(sys.argv[5]), sys.argv[6]
if op == 'decode':
    im = Image.open(raw); out = []
    for k in range(im.n_frames):
        im.seek(k); out.append(im.convert('RGBA').tobytes())
    open(target, 'wb').write(b''.join(out)); sys.exit(0)
data = open(raw, 'rb').read(); n = w * h * 4
frames = [Image.frombytes('RGBA', (w, h), data[k * n:(k + 1) * n]) for k in range(len(durations))]
opaque = all(f.getextrema()[3][0] == 255 for f in frames)
if opaque: frames = [f.convert('RGB') for f in frames]
d = [max(1, round(x)) for x in durations]
if op == 'apng': frames[0].save(target, save_all=True, append_images=frames[1:], duration=d, loop=0, optimize=True, compress_level=9)
elif op == 'webp': frames[0].save(target, save_all=True, append_images=frames[1:], duration=d, loop=0, lossless=True, quality=100, method=6, minimize_size=True, exact=True)
elif op.startswith('webp-q'): frames[0].save(target, save_all=True, append_images=frames[1:], duration=d, loop=0, quality=int(op[6:]), method=6, minimize_size=True)
`;
const pillow = (op, raw, m, target) => run('python3', ['-c', PILLOW, op, raw, String(m.width), String(m.height), JSON.stringify(m.durations), target], {maxBuffer: 1 << 24});
const size = async file => (await readFile(file)).length;
const timed = async fn => { const start = performance.now(); const value = await fn(); return {value, ms: performance.now() - start}; };

// Mean SSIMULACRA2 over every fifth frame, original against decoded.
async function quality(original, decoded, m) {
  if (!ssimulacra2) return null;
  const n = m.width * m.height * 4, scores = [];
  for (let k = 0; k < m.durations.length; k += 5) {
    const a = join(work, 'a.png'), b = join(work, 'b.png');
    await writeFile(join(work, 'fa.rgba'), original.subarray(k * n, (k + 1) * n));
    await writeFile(join(work, 'fb.rgba'), decoded.subarray(k * n, (k + 1) * n));
    await run('python3', ['-c', `import sys\nfrom PIL import Image\nImage.frombytes('RGBA', (${m.width}, ${m.height}), open(sys.argv[1], 'rb').read()).save(sys.argv[3])\nImage.frombytes('RGBA', (${m.width}, ${m.height}), open(sys.argv[2], 'rb').read()).save(sys.argv[4])`,
      join(work, 'fa.rgba'), join(work, 'fb.rgba'), a, b]);
    const {stdout} = await run(ssimulacra2, [a, b]);
    scores.push(Number(stdout.trim().split(/\s+/).pop()));
  }
  return Number((scores.reduce((x, y) => x + y, 0) / scores.length).toFixed(2));
}

// Coalesced frames of a JPEG XL file through djxl, as one RGBA buffer; the frame count must match.
async function jxlFrames(bytes, m) {
  await writeFile(join(work, 'd.jxl'), bytes);
  await run(djxl, [join(work, 'd.jxl'), join(work, 'd.apng'), '--num_threads=0', '--quiet']);
  const {frames} = readAPNG(new Uint8Array(await readFile(join(work, 'd.apng'))));
  return Buffer.concat(frames.map(f => f.data));
}

const results = [];
for (const file of (await readdir(corpus)).filter(f => f.endsWith('.json')).sort()) {
  const name = file.slice(0, -5);
  if (only && name !== only) continue;
  const m = JSON.parse(await readFile(join(corpus, file), 'utf8')), raw = join(corpus, name + '.rgba'), all = new Uint8Array(await readFile(raw));
  const n = m.width * m.height * 4, frames = m.durations.map((duration, k) => ({data: all.subarray(k * n, (k + 1) * n), duration}));
  const source = SOURCES.find(s => s.name === name), row = {name, width: m.width, height: m.height, frames: frames.length, rgbaBytes: all.length, results: {}};
  const add = (key, value) => { row.results[key] = value; console.log(name, key, JSON.stringify(value)); };
  const animation = {width: m.width, height: m.height, loops: m.loops, frames};
  for (const effort of [1, 3, 7]) {
    const {value, ms} = await timed(() => encodeAnimation(animation, {effort}));
    add('rapier lossless e' + effort, {bytes: value.length, msPerFrame: Number((ms / frames.length).toFixed(1))});
  }
  for (const [label, options] of [['rapier q90 e3', {quality: 90, effort: 3}], ['rapier q90 e7', {quality: 90, effort: 7}], ['rapier q95 e7', {quality: 95, effort: 7}]]) {
    const {value, ms} = await timed(() => encodeAnimation(animation, options));
    const decoded = djxl ? await jxlFrames(value, m) : null, aligned = decoded && decoded.length === all.length ? decoded : null;
    add(label, {bytes: value.length, msPerFrame: Number((ms / frames.length).toFixed(1)), ssimulacra2: aligned ? await quality(all, aligned, m) : null});
  }
  if (rapierOnly) { results.push(row); continue; }
  if (source.kind === 'gif') add('gif (original)', {bytes: await size(await (async () => join(process.env.ANIMATION_CACHE || corpus, decodeURIComponent(source.url.split('/').pop())))())});
  else {
    const gif = join(work, name + '.gif');
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', m.width + 'x' + m.height, '-r', String(1000 / m.durations[0]), '-i', raw,
      '-vf', 'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=diff_mode=rectangle', gif]);
    add('gif (ffmpeg, 256 colors)', {bytes: await size(gif)});
  }
  const apng = join(work, name + '.apng');
  {
    const {ms} = await timed(() => pillow('apng', raw, m, apng));
    add('apng (Pillow, optimized)', {bytes: await size(apng), msPerFrame: Number((ms / frames.length).toFixed(1))});
  }
  const webp = join(work, name + '.webp');
  { const {ms} = await timed(() => pillow('webp', raw, m, webp)); add('webp lossless (method 6)', {bytes: await size(webp), msPerFrame: Number((ms / frames.length).toFixed(1))}); }
  {
    const lossy = join(work, name + '-q90.webp');
    const {ms} = await timed(() => pillow('webp-q90', raw, m, lossy));
    await pillow('decode', lossy, m, join(work, 'w.rgba'));
    const decoded = new Uint8Array(await readFile(join(work, 'w.rgba')));
    add('webp q90 (method 6)', {bytes: await size(lossy), msPerFrame: Number((ms / frames.length).toFixed(1)), ssimulacra2: decoded.length === all.length ? await quality(all, decoded, m) : null});
  }
  if (cjxl) for (const [label, args] of [['cjxl lossless e7', ['-d', '0', '-e', '7']], ['cjxl lossless e9', ['-d', '0', '-e', '9']], ['cjxl d1 e7', ['-d', '1', '-e', '7']]]) {
    const target = join(work, name + '.jxl');
    const {ms} = await timed(() => run(cjxl, [apng, target, ...args, '--num_threads=0', '--quiet']));
    const bytes = await readFile(target);
    const decoded = djxl && args[1] !== '0' ? await jxlFrames(bytes, m) : null;
    add(label, {bytes: bytes.length, msPerFrame: Number((ms / frames.length).toFixed(1)), ...(args[1] !== '0' ? {ssimulacra2: decoded && decoded.length === all.length ? await quality(all, decoded, m) : null} : {})});
  }
  results.push(row);
}
await writeFile(output, JSON.stringify({node: process.version, date: new Date().toISOString().slice(0, 10), results}, null, 2) + '\n');
await rm(work, {recursive: true, force: true});
