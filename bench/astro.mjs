// node astro.mjs <node_modules> <pictures> <out>: Astro's line. One page of every picture at 600 and 1200 px, built with
// Astro's default WebP and with the integration's format="jxl" (effort 3, EFFORT), from an empty cache. Each JPEG XL
// file is compared with the WebP file of the same picture and width: bytes, whether it is exact, and SSIMULACRA 2 of
// both against the raster Astro gave the encoders. One JSON line a pair, then the totals for photographs (the files
// that are not exact) and for the files answered exact (charts and screenshots). <node_modules> holds astro, sharp
// and jpegxl.
import {execFileSync} from 'node:child_process';
import {cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {basename, join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {entry, packageDir, score} from './package.mjs';

const [modules, pictures, out] = process.argv.slice(2), effort = Number(process.env.EFFORT ?? 3);
const sharp = createRequire(join(modules, 'x.js'))('sharp'), {header} = await entry(modules, 'metadata');
const scratch = await mkdtemp(join(tmpdir(), 'astro-bench-'));
const files = (await readdir(pictures)).filter(name => /\.(jpe?g|png)$/i.test(name)).sort();
const page = `---
import {Image} from 'astro:assets';
const all = import.meta.glob('../assets/*', {eager: true});
const format = import.meta.env.JXL ? 'jxl' : undefined;
---
{Object.values(all).map(m => [600, 1200].map(w => <Image src={m.default} width={w} alt="" format={format} />))}
`;
async function site(label, integrations, env) {
  const root = join(out, label);
  await rm(root, {recursive: true, force: true});
  await mkdir(join(root, 'src/pages'), {recursive: true}); await mkdir(join(root, 'src/assets'));
  await symlink(modules, join(root, 'node_modules'));
  await cp(join(packageDir(modules), 'examples/astro'), join(root, 'jxl'), {recursive: true});
  // Four-digit prefixes pair each output with its source.
  for (const [i, file] of files.entries()) await cp(join(pictures, file), join(root, 'src/assets', `${String(i).padStart(4, '0')}-${file}`));
  await writeFile(join(root, 'src/pages/index.astro'), page);
  await writeFile(join(root, 'astro.config.mjs'), `import {defineConfig} from 'astro/config';\nimport jxl from './jxl/index.mjs';\n` +
    `export default defineConfig({cacheDir: './.cache', integrations: [${integrations}]});\n`);
  execFileSync(join(modules, '.bin', 'astro'), ['build'], {cwd: root, env: {...process.env, ...env}, stdio: 'pipe'});
  return root;
}
const webp = await site('webp', '', {}), jxl = await site('jxl', `jxl({effort: ${effort}})`, {JXL: '1'});
const outputs = async (root, ext) => (await readdir(join(root, 'dist/_astro'))).filter(name => name.endsWith(ext)).map(name => join(root, 'dist/_astro', name));
const webps = [];
for (const path of await outputs(webp, '.webp')) { const {width, height} = await sharp(path).metadata(); webps.push({path, width, height}); }
const totals = {photos: {files: 0, jxlBytes: 0, webpBytes: 0, jxlLook: 0, webpLook: 0, lowerLook: 0}, exact: {files: 0, jxlBytes: 0, webpBytes: 0}};
for (const path of (await outputs(jxl, '.jxl')).sort()) {
  const bytes = await readFile(path), {width, height} = header(bytes), prefix = basename(path).slice(0, 4);
  const source = (await readdir(join(jxl, 'src/assets'))).find(name => name.startsWith(prefix));
  const raster = await sharp(join(jxl, 'src/assets', source), {failOn: 'none'}).rotate().resize({width, height, withoutEnlargement: true})
    .ensureAlpha().raw().toBuffer();
  const reference = join(scratch, 'reference.png');
  await sharp(raster, {raw: {width, height, channels: 4}}).png().toFile(reference);
  execFileSync(process.env.JXL_DJXL, [path, join(scratch, 'decoded.pam')], {stdio: 'ignore'});
  const pam = await readFile(join(scratch, 'decoded.pam')), samples = pam.subarray(pam.indexOf('ENDHDR\n') + 7);
  const depth = Number(/DEPTH (\d+)/.exec(pam.subarray(0, 200).toString())[1]);
  let exact = samples.length === width * height * depth;
  for (let p = 0; exact && p < width * height; p++) for (let c = 0; c < 3; c++) if (samples[p * depth + c] !== raster[p * 4 + c]) { exact = false; break; }
  const other = webps.find(w => basename(w.path).startsWith(prefix) && w.width === width && w.height === height);
  const webpBytes = (await readFile(other.path)).length;
  await sharp(other.path).png().toFile(join(scratch, 'webp.png'));
  const row = {source, width, height, exact, jxl: {bytes: bytes.length, score: score(reference, path, scratch)},
    webp: {bytes: webpBytes, score: score(reference, join(scratch, 'webp.png'), scratch)}};
  console.log(JSON.stringify(row));
  const t = exact ? totals.exact : totals.photos;
  t.files++; t.jxlBytes += row.jxl.bytes; t.webpBytes += row.webp.bytes;
  if (!exact) { t.jxlLook += row.jxl.score; t.webpLook += row.webp.score; if (row.jxl.score < row.webp.score) t.lowerLook++; }
}
const {photos, exact} = totals;
console.log(JSON.stringify({effort, photos: {files: photos.files, smallerThanWebp: +(1 - photos.jxlBytes / photos.webpBytes).toFixed(3),
  meanLook: +(photos.jxlLook / photos.files).toFixed(1), webpMeanLook: +(photos.webpLook / photos.files).toFixed(1), lowerLook: photos.lowerLook},
  exact: {files: exact.files, ofWebpBytes: +(exact.jxlBytes / exact.webpBytes).toFixed(3)}}));
