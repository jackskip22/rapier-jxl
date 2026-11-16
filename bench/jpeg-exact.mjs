// node jpeg-exact.mjs <node_modules> <folder>: every JPEG in the folder through `recompress` at effort 3 (EFFORT), each
// checked to restore exactly. One JSON line a JPEG, then the totals. The JPEG lines of Astro, Vite and Workers.
import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {entry} from './package.mjs';

const [modules, folder] = process.argv.slice(2), effort = Number(process.env.EFFORT ?? 3);
const {recompress, restore} = await entry(modules, 'jpeg');
let before = 0, after = 0;
const ratios = [];
for (const file of (await readdir(folder)).filter(name => /\.jpe?g$/i.test(name)).sort()) {
  const jpeg = new Uint8Array(await readFile(join(folder, file)));
  let result;
  try { result = await recompress(jpeg, {effort}); } catch (error) { console.log(JSON.stringify({file, refused: error.code})); continue; }
  if (!result.bytes) { console.log(JSON.stringify({file, refused: result.reason.code})); continue; }
  if (!Buffer.from((await restore(result.bytes)).bytes).equals(jpeg)) throw new Error(`${file} does not restore exactly`);
  before += jpeg.length; after += result.bytes.length; ratios.push(result.bytes.length / jpeg.length);
  console.log(JSON.stringify({file, jpegBytes: jpeg.length, jxlBytes: result.bytes.length, restoresExactly: true}));
}
ratios.sort((a, b) => a - b);
console.log(JSON.stringify({files: ratios.length, effort, before, after, smaller: +(1 - after / before).toFixed(3),
  medianSmaller: +(1 - ratios[ratios.length >> 1]).toFixed(3)}));
