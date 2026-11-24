// SPDX-License-Identifier: MIT
// JPEG XL for next/image (Next.js 15 and 16). Run after `next build` (the `postbuild` script `npx jpegxl add next`
// writes): every JPEG and PNG in public/ and every image the build imported gets one .jxl per width next/image asks
// for, under public/_jxl/ (and out/_jxl/ for a static export). rapier-jxl-next-proxy.mjs then answers next/image's
// requests with them where the browser sends `Accept: image/jxl`; every other browser gets Next's own image as today.
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {inspect} from 'jpegxl/metadata';
import {IMAGE, jxlFiles} from '../files/index.mjs';

// next/image's widths when next.config sets none (Next 15 and 16).
const DEVICE = [640, 750, 828, 1080, 1200, 1920, 2048, 3840], SIZES = [32, 48, 64, 96, 128, 256, 384];
export const JXL_DIR = '_jxl';
/** Where a width of a picture is kept, from the picture's URL path: /_jxl/w640/photos/hero.jpg.jxl */
export const jxlPath = (url, width) => `/${JXL_DIR}/w${width}${url}.jxl`;

async function images(dir, base) {
  let names;
  try { names = await readdir(dir, {recursive: true}); } catch { return []; }
  return names.filter(name => IMAGE.test(name) && !name.split(sep).includes(JXL_DIR)).map(name => ({file: join(dir, name), url: base + name.split(sep).join('/')}));
}

// rapier-jxl reads each picture and resizes each width itself, in linear light, so nothing else is installed. A JPEG at
// full size is kept exactly (it restores byte for byte); each smaller width is a resized picture at the look.
/** @param {import('./index.d.ts').NextJxlOptions} [options] */
// Quality 64 is the look of Next's default WebP (q75) on the median photograph: the bisected match over 11 photographs
// at four widths ranged 47 to 71.
export async function writeNextJxl({root = process.cwd(), fidelity = {quality: 64}, effort = 3, log = console.log} = {}) {
  root = resolve(root);
  const dist = join(root, '.next');
  let config = {};
  try { config = JSON.parse(await readFile(join(dist, 'required-server-files.json'), 'utf8')).config ?? {}; }
  catch { throw Object.assign(new Error("Missing build: no .next/required-server-files.json."), {code: 'JXL_SETUP', fix: 'npm run build: this step runs as its postbuild.'}); }
  const imagesConfig = config.images ?? {};
  const widths = [...new Set([...(imagesConfig.deviceSizes ?? DEVICE), ...(imagesConfig.imageSizes ?? SIZES)])].sort((a, b) => a - b);
  const exported = config.output === 'export';
  const files = jxlFiles({fidelity, effort, cacheDir: join(dist, 'cache', 'rapier-jxl')});
  const found = [...await images(join(root, 'public'), '/'), ...await images(join(dist, 'static', 'media'), '/_next/static/media/')];
  const targets = [join(root, 'public'), ...(exported ? [join(root, config.distDir && config.distDir !== '.next' ? config.distDir : 'out')] : [])];
  let written = 0, bytesIn = 0, bytesOut = 0;
  const left = [];
  const started = performance.now();
  for (const {file, url} of found) {
    const source = new Uint8Array(await readFile(file));
    let own;
    // The width the picture shows at: an Exif orientation of 5 to 8 turns it a quarter.
    try { const info = await inspect(source); own = info.orientation >= 5 ? info.height : info.width; }
    catch (error) { left.push(relative(root, file)); log(`rapier-jxl left ${relative(root, file)} as it is: ${error.message}`); continue; }
    let previous = null;
    for (const width of widths) {
      // Next serves a picture no wider than it is: a wider request gets the full-size file.
      if (previous && previous.full) { await save(width, previous.bytes); continue; }
      const full = width >= own;
      let out;
      try { out = await files.toJxl(file, {bytes: source, width: full ? undefined : width}); }
      catch (error) { left.push(`${relative(root, file)} at ${width} px`); log(`rapier-jxl left ${relative(root, file)} at ${width} px as it is: ${error.code || ''} ${error.message}`); continue; }
      previous = {full, bytes: out.bytes};
      await save(width, out.bytes);
    }
    bytesIn += source.length;
    async function save(width, bytes) {
      for (const target of targets) {
        const to = join(target, ...jxlPath(url, width).split('/'));
        await mkdir(dirname(to), {recursive: true}); await writeFile(to, bytes);
      }
      written++; bytesOut += bytes.length;
    }
  }
  const summary = {pictures: found.length, files: written, left, widths, inputBytes: bytesIn, outputBytes: bytesOut, ms: Math.round(performance.now() - started), exported};
  log(`rapier-jxl: ${found.length} pictures, ${written} JPEG XL files in public/${JXL_DIR}${exported ? ' and the export' : ''} (${summary.ms} ms)`);
  return summary;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // Options ride on the postbuild script: node rapier-jxl-next.mjs --quality 80 --effort 5 [--json]
  const args = process.argv.slice(2), json = args.includes('--json');
  const run = async () => {
    const options = {log: json ? () => {} : console.log}, seen = new Set();
    const refuse = message => { throw Object.assign(new Error(message), {code: 'JXL_OPTIONS'}); };
    for (let i = 0; i < args.length; i++) {
      const flag = args[i];
      if (!['--quality', '--effort', '--json'].includes(flag)) refuse(`Unknown option: ${flag}`);
      if (seen.has(flag)) refuse(`Repeated option: ${flag}`);
      seen.add(flag);
      if (flag === '--json') continue;
      const value = Number(args[++i]);
      if (flag === '--quality') {
        if (!Number.isFinite(value) || value < 1 || value > 100) refuse('quality: number from 1 to 100');
        options.fidelity = {quality: value};
      } else {
        if (!Number.isInteger(value) || value < 1 || value > 9) refuse('effort: integer from 1 to 9');
        options.effort = value;
      }
    }
    return writeNextJxl(options);
  };
  run().then(summary => { if (json) console.log(JSON.stringify(summary)); }, error => {
    console.error(`rapier-jxl: ${error.code || ''} ${error.message}${error.fix ? ' Fix: ' + error.fix : ''}`);
    process.exitCode = 1;
  });
}
