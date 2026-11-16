// A JPEG kept as a smaller JPEG XL file that restores the JPEG exactly.
// Usage: node jpeg-exact.mjs camera.jpg camera.jxl
import {readFile, writeFile} from 'node:fs/promises';
import {recompress, restore} from 'jpegxl/jpeg';

const [from = 'camera.jpg', to = 'camera.jxl'] = process.argv.slice(2);
const jpeg = new Uint8Array(await readFile(from));
const kept = await recompress(jpeg);
const back = await restore(kept.bytes);
if (Buffer.compare(jpeg, back.bytes) !== 0) throw new Error('The restored JPEG differs.');
await writeFile(to, kept.bytes);
console.log(`${jpeg.length} -> ${kept.bytes.length} bytes; the JPEG restores exactly`);
