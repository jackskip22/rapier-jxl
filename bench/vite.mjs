// node vite.mjs <node_modules> <pictures>: Vite's photo line. Each PNG at the plug-in's default (quality 90, effort 3,
// EFFORT) and sharp's WebP and AVIF at the smallest quality whose SSIMULACRA 2 reaches the JPEG XL file's. One JSON line
// a picture, then how much smaller the JPEG XL files are in total. <node_modules> holds sharp and jpegxl.
import {mkdtemp, readdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {entry, score} from './package.mjs';

const [modules, pictures] = process.argv.slice(2), effort = Number(process.env.EFFORT ?? 3);
const sharp = createRequire(join(modules, 'x.js'))('sharp'), {encode} = await entry(modules, '.');
const scratch = await mkdtemp(join(tmpdir(), 'vite-bench-'));
const look = async (reference, bytes, ext) => {
  const file = join(scratch, 'out' + ext);
  if (ext === '.jxl') await writeFile(file, bytes); else await sharp(bytes).png().toFile(file);
  return score(reference, file, scratch);
};
async function smallest(format, reference, target) {
  let lo = 1, hi = 100, best = null;
  while (lo <= hi) {
    const quality = (lo + hi) >> 1, bytes = await sharp(reference)[format]({quality}).toBuffer();
    if (await look(reference, bytes, '.png') >= target) { best = {quality, bytes: bytes.length}; hi = quality - 1; } else lo = quality + 1;
  }
  return best;
}
const sum = {jxl: 0, webp: 0, avif: 0, jxlForWebp: 0, jxlForAvif: 0};
for (const file of (await readdir(pictures)).filter(name => /\.png$/i.test(name)).sort()) {
  const reference = join(pictures, file), png = await readFile(reference);
  const result = await encode(new Blob([png]), {fidelity: {quality: 90}, effort}), target = await look(reference, result.bytes, '.jxl');
  const row = {file, jxl: {bytes: result.bytes.length, score: target}, webp: await smallest('webp', reference, target), avif: await smallest('avif', reference, target)};
  console.log(JSON.stringify(row));
  if (row.webp) { sum.webp += row.webp.bytes; sum.jxlForWebp += row.jxl.bytes; }
  if (row.avif) { sum.avif += row.avif.bytes; sum.jxlForAvif += row.jxl.bytes; }
}
console.log(JSON.stringify({effort, smallerThanWebp: +(1 - sum.jxlForWebp / sum.webp).toFixed(3), smallerThanAvif: +(1 - sum.jxlForAvif / sum.avif).toFixed(3)}));
