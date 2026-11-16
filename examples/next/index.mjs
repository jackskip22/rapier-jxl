// SPDX-License-Identifier: MIT
// JPEG XL for next/image (Next.js 15 and 16). Run after `next build` (the `postbuild` script `npx jpegxl add next`
// writes): every JPEG and PNG in public/ and every image the build imported gets one .jxl per width next/image asks
// for, under public/_jxl/ (and out/_jxl/ for a static export). rapier-jxl-next-proxy.mjs then answers next/image's
// requests with them where the browser sends `Accept: image/jxl`; every other browser gets Next's own image as today.
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';
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

// sharp comes with Next (it is Next's own image library). It decodes and resizes each width exactly as Next's optimizer
// does, so a browser with JPEG XL sees the same picture as one without; rapier-jxl encodes it. A JPEG is not kept
// exactly here: next/image's files are resized pictures at a look.
// Sharp hands back 8-bit samples unless asked for more: a 16-bit picture stays 16-bit, and an RGB profile stays on the
// pixels it describes (gray and CMYK are converted away from theirs).
const sharpRead = sharp => async (bytes, file, {width} = {}) => {
  const image = sharp(bytes), meta = await image.metadata(), wide = meta.depth === 'ushort';
  image.rotate();
  if (width) image.resize({width, withoutEnlargement: true});
  if (wide) image.toColorspace('rgb16');
  const {data, info} = await image.ensureAlpha().raw({depth: wide ? 'ushort' : 'uchar'}).toBuffer({resolveWithObject: true});
  const icc = meta.icc && !['b-w', 'grey16', 'cmyk'].includes(meta.space) && !(meta.channels < 3) ? new Uint8Array(meta.icc) : undefined;
  const samples = wide ? new Uint16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return {width: info.width, height: info.height, data: samples, ...(icc && {icc})};
};

/** @param {import('./index.d.ts').NextJxlOptions} [options] */
// Quality 64 is the look of Next's default WebP (q75) on the median photograph: the bisected match over 11 photographs
// at four widths ranged 47 to 71.
export async function writeNextJxl({root = process.cwd(), fidelity = {quality: 64}, effort = 3, log = console.log} = {}) {
  root = resolve(root);
  const dist = join(root, '.next');
  let config = {};
  try { config = JSON.parse(await readFile(join(dist, 'required-server-files.json'), 'utf8')).config ?? {}; }
  catch { throw Object.assign(new Error("Missing build; run next build."), {code: 'JXL_SETUP', fix: 'run next build first: this step runs as postbuild.'}); }
  const imagesConfig = config.images ?? {};
  const widths = [...new Set([...(imagesConfig.deviceSizes ?? DEVICE), ...(imagesConfig.imageSizes ?? SIZES)])].sort((a, b) => a - b);
  const exported = config.output === 'export';
  let sharp;
  try { sharp = (await import(pathToFileURL(createRequire(join(root, 'package.json')).resolve('sharp')))).default; }
  catch { throw Object.assign(new Error("Missing sharp; run npm install sharp."), {code: 'JXL_SETUP', fix: 'npm install sharp'}); }
  const files = jxlFiles({fidelity, effort, read: sharpRead(sharp), cacheDir: join(dist, 'cache', 'rapier-jxl')});
  const found = [...await images(join(root, 'public'), '/'), ...await images(join(dist, 'static', 'media'), '/_next/static/media/')];
  const targets = [join(root, 'public'), ...(exported ? [join(root, config.distDir && config.distDir !== '.next' ? config.distDir : 'out')] : [])];
  let written = 0, bytesIn = 0, bytesOut = 0;
  const left = [];
  const started = performance.now();
  for (const {file, url} of found) {
    const source = new Uint8Array(await readFile(file));
    let own;
    try { own = (await sharp(source).rotate().metadata()).autoOrient?.width ?? (await sharp(source).metadata()).width; }
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
  const args = process.argv.slice(2), value = flag => { const i = args.indexOf(flag); return i < 0 ? undefined : Number(args[i + 1]); };
  const json = args.includes('--json'), quality = value('--quality'), effort = value('--effort');
  writeNextJxl({log: json ? () => {} : console.log, ...(quality ? {fidelity: {quality}} : {}), ...(effort ? {effort} : {})}).then(summary => { if (json) console.log(JSON.stringify(summary)); }, error => {
    console.error(`rapier-jxl: ${error.code || ''} ${error.message}${error.fix ? ' Fix: ' + error.fix : ''}`);
    process.exitCode = 1;
  });
}
