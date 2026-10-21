// SPDX-License-Identifier: MIT
// Prepares the animation corpus (animation-sources.json) as whole-canvas RGBA frames: <out>/<name>.rgba with
// <out>/<name>.json ({width, height, loops, durations}). GIFs are composited by Pillow, camera clips converted by
// ffmpeg, screen recordings rendered in Chromium by Playwright. None of it uses the encoder under test.
// Usage: node animation-corpus.mjs <out> [--cache <downloads>]   (needs python3 with Pillow, ffmpeg, Playwright)
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {inflateSync} from 'node:zlib';

const run = promisify(execFile);
const [out] = process.argv.slice(2), cache = process.argv.includes('--cache') ? process.argv[process.argv.indexOf('--cache') + 1] : out;
if (!out) { console.error('usage: node animation-corpus.mjs <out> [--cache <downloads>]'); process.exit(2); }
const {sources} = JSON.parse(await readFile(new URL('animation-sources.json', import.meta.url), 'utf8'));
await mkdir(out, {recursive: true});

async function download({url, sha256}) {
  const file = join(cache, decodeURIComponent(url.split('/').pop()));
  if (!existsSync(file)) {
    const response = await fetch(url, {headers: {'user-agent': 'rapier-jxl-bench/1.0 (animation corpus)'}});
    if (!response.ok) throw new Error(url + ': HTTP ' + response.status);
    await writeFile(file, Buffer.from(await response.arrayBuffer()));
  }
  const bytes = await readFile(file);
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error(file + ' does not match its SHA-256');
  return file;
}

const PILLOW = `
import sys, json
from PIL import Image
im = Image.open(sys.argv[1]); frames = []; durations = []
for k in range(im.n_frames):
    im.seek(k); frames.append(im.convert('RGBA').tobytes()); durations.append(im.info.get('duration', 100))
open(sys.argv[2], 'wb').write(b''.join(frames))
loop = im.info.get('loop', 1)
print(json.dumps({'width': im.size[0], 'height': im.size[1], 'loops': 0 if loop == 0 else loop + 1 if 'loop' in im.info else 1, 'durations': durations}))
`;

function unpng(png) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength), width = view.getUint32(16), height = view.getUint32(20), channels = {2: 3, 6: 4}[png[25]], idat = [];
  for (let at = 8; at < png.length;) { const length = view.getUint32(at); if (String.fromCharCode(...png.subarray(at + 4, at + 8)) === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length)); at += 12 + length; }
  const raw = inflateSync(Buffer.concat(idat)), stride = width * channels, rgba = new Uint8Array(width * height * 4), line = new Uint8Array(stride), up = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i], a = i >= channels ? line[i - channels] : 0, b = up[i], c = i >= channels ? up[i - channels] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      line[i] = (filter === 0 ? x : filter === 1 ? x + a : filter === 2 ? x + b : filter === 3 ? x + ((a + b) >> 1) : x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
    }
    for (let x = 0; x < width; x++) for (let c = 0; c < 4; c++) rgba[(y * width + x) * 4 + c] = c < channels ? line[x * channels + c] : 255;
    up.set(line);
  }
  return rgba;
}

// Two scenes in an editor-like page: typing with a blinking caret, and a UI demo (a menu opening, a hover, a scroll).
const PAGE = `<!doctype html><meta charset=utf-8><style>
body{margin:0;font:15px/1.5 "DejaVu Sans",sans-serif;color:#111;background:#fff;display:grid;grid-template-columns:180px 1fr;height:500px;overflow:hidden}
nav{background:#f1f2f4;padding:12px}nav div{padding:6px 8px}nav .on{background:#111;color:#fff}
header{grid-column:1/3;height:40px;background:#111;color:#fff;display:flex;align-items:center;padding:0 12px;gap:18px}
main{padding:20px 28px;overflow:hidden;position:relative}#doc{white-space:pre-wrap;font:15px/1.6 "DejaVu Sans Mono",monospace}
#caret{display:inline-block;width:2px;height:18px;background:#111;vertical-align:text-bottom}
#menu{position:absolute;right:20px;top:0;background:#111;color:#fff;width:200px;overflow:hidden;transition:none}
#menu div{padding:8px 12px}#menu .hover{background:#444}
</style><body style="grid-template-rows:40px 1fr"><header><b>Notes</b><span>File</span><span>Edit</span><span>View</span></header>
<nav><div class=on>Today</div><div>Ideas</div><div>Reading</div><div>Recipes</div><div>Travel</div><div>Archive</div></nav>
<main><div id=doc></div><div id=menu style="height:0"><div>New note</div><div>Duplicate</div><div>Export as JPEG XL</div><div>Print</div></div></main>`;
const TEXT = 'Animated JPEG XL keeps every frame exact.\\nOnly the changed rectangle is stored, so a screen\\nrecording costs little more than one screenshot.\\n\\n- Smaller than GIF\\n- Full color and alpha\\n';

async function screen({width, height, frames, scene}) {
  const {chromium} = await import(process.env.PLAYWRIGHT_ROOT ? process.env.PLAYWRIGHT_ROOT + '/playwright-core/index.mjs' : '/opt/node-tools/node_modules/playwright-core/index.mjs');
  const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium'});
  try {
    const page = await browser.newPage({viewport: {width, height}, deviceScaleFactor: 1});
    await page.setContent(PAGE);
    const data = [];
    for (let k = 0; k < frames; k++) {
      await page.evaluate(([k, scene, text]) => {
        const doc = document.getElementById('doc'), menu = document.getElementById('menu');
        if (scene === 'typing') { doc.textContent = text.slice(0, k * 3); const caret = document.createElement('span'); caret.id = 'caret'; caret.style.visibility = k % 6 < 3 ? 'visible' : 'hidden'; doc.append(caret); }
        else {
          doc.textContent = text.repeat(4); menu.style.height = Math.min(160, k * 20) + 'px';
          [...menu.children].forEach((item, i) => item.className = k >= 12 && Math.floor((k - 12) / 4) % 4 === i ? 'hover' : '');
          document.querySelector('main').scrollTop = k >= 28 ? (k - 28) * 12 : 0;
        }
      }, [k, scene, TEXT.replaceAll('\\n', '\n')]);
      data.push(unpng(await page.screenshot({type: 'png'})));
    }
    return data;
  } finally { await browser.close(); }
}

for (const source of sources) {
  const target = join(out, source.name + '.rgba');
  let manifest;
  if (source.kind === 'gif') {
    const {stdout} = await run('python3', ['-c', PILLOW, await download(source), target], {maxBuffer: 1 << 20});
    manifest = JSON.parse(stdout);
  } else if (source.kind === 'y4m') {
    const file = await download(source);
    await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-frames:v', String(source.frames), '-f', 'rawvideo', '-pix_fmt', 'rgba', target]);
    const header = (await readFile(file)).subarray(0, 100).toString('latin1');
    manifest = {width: Number(/ W(\d+)/.exec(header)[1]), height: Number(/ H(\d+)/.exec(header)[1]), loops: 0, durations: Array(source.frames).fill(source.duration)};
  } else {
    const frames = await screen(source);
    await writeFile(target, Buffer.concat(frames));
    manifest = {width: source.width, height: source.height, loops: 0, durations: Array(source.frames).fill(source.duration)};
  }
  manifest.sha256 = createHash('sha256').update(await readFile(target)).digest('hex');
  await writeFile(join(out, source.name + '.json'), JSON.stringify(manifest) + '\n');
  console.log(source.name, manifest.width + 'x' + manifest.height, manifest.durations.length, 'frames');
}
